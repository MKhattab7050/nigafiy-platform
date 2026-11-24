//go:build windows

package shell

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// conpty is Windows PowerShell in a pseudo console (ConPTY, Windows 10 1809 and later): colours,
// line editing, tab completion and full-screen programs behave as in a terminal window. The
// shell and everything it starts sit in a job object that is killed with the shell.
type conpty struct {
	hpc     windows.Handle
	proc    windows.Handle
	job     windows.Handle
	in      *os.File // write: keystrokes
	out     *os.File // read: the console's output (VT sequences)
	name    string
	once    sync.Once
	waitErr error
	code    int
	done    chan struct{}
}

func startTerminal(cols, rows int) (Terminal, error) {
	exe, err := findPowerShell()
	if err != nil {
		return nil, err
	}
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, fmt.Errorf("create input pipe: %w", err)
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		_ = windows.CloseHandle(inR)
		_ = windows.CloseHandle(inW)
		return nil, fmt.Errorf("create output pipe: %w", err)
	}
	closeAll := func(hs ...windows.Handle) {
		for _, h := range hs {
			if h != 0 {
				_ = windows.CloseHandle(h)
			}
		}
	}
	var hpc windows.Handle
	if err := windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, inR, outW, 0, &hpc); err != nil {
		closeAll(inR, inW, outR, outW)
		return nil, fmt.Errorf("the pseudo console is not available (Windows 10 1809 or later): %w", err)
	}
	// The pseudo console holds its own copies of these ends.
	closeAll(inR, outW)

	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.ClosePseudoConsole(hpc)
		closeAll(inW, outR)
		return nil, err
	}
	defer attrs.Delete()
	// The attribute's value is the HPCON itself (not a pointer to it).
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&hpc)), unsafe.Sizeof(hpc)); err != nil {
		windows.ClosePseudoConsole(hpc)
		closeAll(inW, outR)
		return nil, err
	}
	si := windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(si))
	// No standard handles from this process: the shell's console is the pseudo console.
	si.Flags |= windows.STARTF_USESTDHANDLES
	cmdline, err := windows.UTF16PtrFromString(windows.EscapeArg(exe) + " -NoLogo")
	if err != nil {
		windows.ClosePseudoConsole(hpc)
		closeAll(inW, outR)
		return nil, err
	}
	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(nil, cmdline, nil, nil, false, flags, nil, nil, &si.StartupInfo, &pi); err != nil {
		windows.ClosePseudoConsole(hpc)
		closeAll(inW, outR)
		return nil, fmt.Errorf("start PowerShell: %w", err)
	}
	job, jerr := killOnCloseJob()
	if jerr == nil {
		if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
			_ = windows.CloseHandle(job)
			job = 0
		}
	}
	_, _ = windows.ResumeThread(pi.Thread)
	_ = windows.CloseHandle(pi.Thread)
	t := &conpty{
		hpc:  hpc,
		proc: pi.Process,
		job:  job,
		in:   os.NewFile(uintptr(inW), "conpty-in"),
		out:  os.NewFile(uintptr(outR), "conpty-out"),
		name: exe,
		done: make(chan struct{}),
	}
	go t.wait()
	return t, nil
}

func killOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func findPowerShell() (string, error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	p := root + `\System32\WindowsPowerShell\v1.0\powershell.exe`
	if _, err := os.Stat(p); err == nil {
		return p, nil
	}
	return "", errors.New("Windows PowerShell was not found")
}

func (t *conpty) wait() {
	defer close(t.done)
	_, err := windows.WaitForSingleObject(t.proc, windows.INFINITE)
	if err != nil {
		t.waitErr = err
		t.code = -1
		return
	}
	var code uint32
	if err := windows.GetExitCodeProcess(t.proc, &code); err != nil {
		t.waitErr = err
		t.code = -1
		return
	}
	t.code = int(int32(code))
	// The shell is gone: closing the pseudo console ends the output (Read returns EOF).
	go t.closeConsole()
}

func (t *conpty) closeConsole() {
	t.once.Do(func() {
		done := make(chan struct{})
		go func() {
			windows.ClosePseudoConsole(t.hpc)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			// Older builds wait for the output to be read; Close closes our end below.
		}
	})
}

func (t *conpty) Read(p []byte) (int, error)  { return t.out.Read(p) }
func (t *conpty) Write(p []byte) (int, error) { return t.in.Write(p) }
func (t *conpty) Kind() string                { return "conpty" }
func (t *conpty) Name() string                { return t.name }

func (t *conpty) Resize(cols, rows int) error {
	return windows.ResizePseudoConsole(t.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (t *conpty) Wait() (int, error) {
	<-t.done
	return t.code, t.waitErr
}

func (t *conpty) Kill() {
	if t.job != 0 {
		_ = windows.TerminateJobObject(t.job, 1)
	}
	_ = windows.TerminateProcess(t.proc, 1)
}

func (t *conpty) Close() error {
	t.Kill()
	select {
	case <-t.done:
	case <-time.After(5 * time.Second):
	}
	t.closeConsole()
	_ = t.in.Close()
	_ = t.out.Close()
	if t.job != 0 {
		_ = windows.CloseHandle(t.job)
	}
	return windows.CloseHandle(t.proc)
}
