//go:build windows

package service

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// WTSLauncher starts the session helper in the active console session as the signed-in user
// (WTSQueryUserToken + CreateProcessAsUser on winsta0\default). It needs LocalSystem (the
// service account): WTSQueryUserToken requires SeTcbPrivilege.
type WTSLauncher struct {
	Exe  string
	Args []string
	// ExtraEnv is appended to the user's environment (tests only).
	ExtraEnv []string
	Log      *slog.Logger

	mu      sync.Mutex
	session uint32
	started bool
}

const noSession = 0xFFFFFFFF

func (l *WTSLauncher) Describe() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.started {
		return fmt.Sprintf("signed-in user's desktop (console session %d)", l.session)
	}
	return "signed-in user's desktop (console session)"
}

// Stale: the console now shows another session than the helper's.
func (l *WTSLauncher) Stale() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.started && windows.WTSGetActiveConsoleSessionId() != l.session
}

func (l *WTSLauncher) Launch(_ context.Context) (io.ReadWriteCloser, func(), error) {
	sid := windows.WTSGetActiveConsoleSessionId()
	if sid == noSession {
		return nil, nil, errors.New("no session is attached to the console")
	}
	var tok windows.Token
	if err := windows.WTSQueryUserToken(sid, &tok); err != nil {
		return nil, nil, fmt.Errorf("nobody is signed in at the console (session %d): %w", sid, err)
	}
	defer tok.Close()
	rwc, stop, err := launchAsToken(tok, l.Exe, l.Args, l.ExtraEnv, l.Log)
	if err != nil {
		return nil, nil, err
	}
	l.mu.Lock()
	l.session, l.started = sid, true
	l.mu.Unlock()
	return rwc, stop, nil
}

// launchAsToken starts exe as the token's user on the interactive desktop with three anonymous
// pipes (stdin, stdout for the protocol; stderr drained into the log). Only those three handles
// are inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), so nothing else of the service leaks into the
// user's process.
func launchAsToken(tok windows.Token, exe string, args, extraEnv []string, log *slog.Logger) (io.ReadWriteCloser, func(), error) {
	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	var inR, inW, outR, outW, errR, errW windows.Handle
	closeAll := func(hs ...*windows.Handle) {
		for _, h := range hs {
			if *h != 0 {
				_ = windows.CloseHandle(*h)
				*h = 0
			}
		}
	}
	if err := windows.CreatePipe(&inR, &inW, sa, 0); err != nil {
		return nil, nil, err
	}
	if err := windows.CreatePipe(&outR, &outW, sa, 0); err != nil {
		closeAll(&inR, &inW)
		return nil, nil, err
	}
	if err := windows.CreatePipe(&errR, &errW, sa, 0); err != nil {
		closeAll(&inR, &inW, &outR, &outW)
		return nil, nil, err
	}
	// The parent's ends stay here.
	for _, h := range []windows.Handle{inW, outR, errR} {
		_ = windows.SetHandleInformation(h, windows.HANDLE_FLAG_INHERIT, 0)
	}
	fail := func(err error) (io.ReadWriteCloser, func(), error) {
		closeAll(&inR, &inW, &outR, &outW, &errR, &errW)
		return nil, nil, err
	}

	env, err := tok.Environ(false)
	if err != nil {
		return fail(fmt.Errorf("the user's environment: %w", err))
	}
	env = append(env, extraEnv...)
	envBlock := utf16EnvBlock(env)

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return fail(err)
	}
	defer attrs.Delete()
	inherit := []windows.Handle{inR, outW, errW}
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&inherit[0]), uintptr(len(inherit))*unsafe.Sizeof(inherit[0])); err != nil {
		return fail(err)
	}

	si := &windows.StartupInfoEx{}
	si.Cb = uint32(unsafe.Sizeof(*si))
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput, si.StdOutput, si.StdErr = inR, outW, errW
	si.Desktop, _ = windows.UTF16PtrFromString(`winsta0\default`)
	si.ProcThreadAttributeList = attrs.List()

	app, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return fail(err)
	}
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{exe}, args...)))
	if err != nil {
		return fail(err)
	}
	var pi windows.ProcessInformation
	flags := uint32(windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NO_WINDOW | windows.EXTENDED_STARTUPINFO_PRESENT)
	if err := windows.CreateProcessAsUser(tok, app, cmdLine, nil, nil, true, flags, &envBlock[0], nil, &si.StartupInfo, &pi); err != nil {
		return fail(fmt.Errorf("start the session helper: %w", err))
	}
	_ = windows.CloseHandle(pi.Thread)
	// The child holds its ends now; closing ours means EOF arrives when it exits.
	closeAll(&inR, &outW, &errW)

	stdin := os.NewFile(uintptr(inW), "helper-stdin")
	stdout := os.NewFile(uintptr(outR), "helper-stdout")
	stderr := os.NewFile(uintptr(errR), "helper-stderr")
	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 4096), 64*1024)
		for sc.Scan() {
			if log != nil {
				log.Debug("session helper", "line", sc.Text())
			}
		}
		_ = stderr.Close()
	}()

	proc := pi.Process
	var once sync.Once
	exited := make(chan struct{})
	go func() {
		_, _ = windows.WaitForSingleObject(proc, windows.INFINITE)
		close(exited)
	}()
	stop := func() {
		once.Do(func() {
			_ = stdin.Close()
			select {
			case <-exited:
			case <-time.After(2 * time.Second):
				_ = windows.TerminateProcess(proc, 1)
				<-exited
			}
			_ = stdout.Close()
			_ = windows.CloseHandle(proc)
		})
	}
	return helperPipe{r: stdout, w: stdin}, stop, nil
}

type helperPipe struct {
	r *os.File
	w *os.File
}

func (p helperPipe) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p helperPipe) Write(b []byte) (int, error) { return p.w.Write(b) }
func (p helperPipe) Close() error {
	_ = p.w.Close()
	return p.r.Close()
}

// utf16EnvBlock: "k=v\0k=v\0\0" in UTF-16, the CREATE_UNICODE_ENVIRONMENT layout. Entries with a
// NUL in them are dropped.
func utf16EnvBlock(env []string) []uint16 {
	var b []uint16
	for _, kv := range env {
		if kv == "" || strings.ContainsRune(kv, 0) {
			continue
		}
		u, err := windows.UTF16FromString(kv)
		if err != nil {
			continue
		}
		b = append(b, u...) // includes the terminating NUL
	}
	if len(b) == 0 {
		b = append(b, 0)
	}
	return append(b, 0)
}
