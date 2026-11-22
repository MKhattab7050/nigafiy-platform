//go:build windows

package service

import (
	"context"
	"io"
	"log/slog"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/lan-detective/endpoint-agent/internal/desktop"
)

func TestOnlyConsoleSessionChangesRestartTheHelper(t *testing.T) {
	for ev, want := range map[uint32]bool{
		wtsConsoleConnect: true, wtsConsoleDisconnect: true, wtsSessionLogon: true, wtsSessionLogoff: true,
		0x3 /* remote connect */ : false, 0x4: false, 0x7 /* lock */ : false, 0x8 /* unlock */ : false,
	} {
		if restartWanted(ev) != want {
			t.Errorf("event %#x: restart=%v", ev, !want)
		}
	}
}

func TestServiceHandlerStopsTheAgentAndForwardsSessionChanges(t *testing.T) {
	ctxSeen := make(chan context.Context, 1)
	var events []uint32
	sessionCh := make(chan uint32, 4)
	h := &handler{
		log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		run: func(ctx context.Context) error {
			ctxSeen <- ctx
			<-ctx.Done()
			return ctx.Err()
		},
		onSession: func(ev uint32) { sessionCh <- ev },
	}
	r := make(chan svc.ChangeRequest)
	s := make(chan svc.Status, 8)
	type result struct {
		specific bool
		code     uint32
	}
	out := make(chan result, 1)
	go func() {
		a, b := h.Execute(nil, r, s)
		out <- result{a, b}
	}()
	if st := <-s; st.State != svc.StartPending {
		t.Fatalf("first status %v", st.State)
	}
	st := <-s
	if st.State != svc.Running || st.Accepts&svc.AcceptSessionChange == 0 || st.Accepts&svc.AcceptStop == 0 || st.Accepts&svc.AcceptShutdown == 0 {
		t.Fatalf("running status %+v", st)
	}
	runCtx := <-ctxSeen
	r <- svc.ChangeRequest{Cmd: svc.SessionChange, EventType: wtsSessionLogon}
	events = append(events, <-sessionCh)
	if !slices.Equal(events, []uint32{wtsSessionLogon}) {
		t.Fatalf("session events %v", events)
	}
	r <- svc.ChangeRequest{Cmd: svc.Interrogate, CurrentStatus: svc.Status{State: svc.Running}}
	if st := <-s; st.State != svc.Running {
		t.Fatalf("interrogate answered %v", st.State)
	}
	r <- svc.ChangeRequest{Cmd: svc.Stop}
	if st := <-s; st.State != svc.StopPending {
		t.Fatalf("stop status %v", st.State)
	}
	select {
	case res := <-out:
		if res.specific || res.code != 0 {
			t.Fatalf("clean stop returned %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return after Stop")
	}
	if runCtx.Err() == nil {
		t.Fatal("the agent's context was not cancelled")
	}
}

func TestServiceHandlerReportsAFailedAgentToTheSCM(t *testing.T) {
	h := &handler{log: slog.New(slog.NewTextHandler(io.Discard, nil)), run: func(context.Context) error { return io.ErrUnexpectedEOF }}
	s := make(chan svc.Status, 4)
	specific, code := h.Execute(nil, make(chan svc.ChangeRequest), s)
	if !specific || code == 0 {
		t.Fatalf("a failing agent must exit with a service-specific code (restart policy): %v %d", specific, code)
	}
}

func TestUTF16EnvironmentBlock(t *testing.T) {
	b := utf16EnvBlock([]string{"A=1", "", "BAD=x\x00y", "B=ü"})
	got := windows.UTF16ToString(b)
	if got != "A=1" {
		t.Fatalf("first entry %q", got)
	}
	want := append(append(windows.StringToUTF16("A=1"), windows.StringToUTF16("B=ü")...), 0)
	if !slices.Equal(b, want) {
		t.Fatalf("block %v, want %v", b, want)
	}
	if e := utf16EnvBlock(nil); !slices.Equal(e, []uint16{0, 0}) {
		t.Fatalf("empty block %v", e)
	}
}

// The service starts the helper with CreateProcessAsUser and the console user's token. Without
// LocalSystem, WTSQueryUserToken is refused, so this runs the same launch with this test's own
// (primary) token: the same CreateProcessAsUser call, desktop, environment block, inherited-handle
// list and pipe protocol, for real.
func TestHelperStartedWithAUserTokenAnswersOverItsPipes(t *testing.T) {
	var own windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY, &own); err != nil {
		t.Fatal(err)
	}
	defer own.Close()
	var primary windows.Token
	if err := windows.DuplicateTokenEx(own, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		t.Fatal(err)
	}
	defer primary.Close()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	rwc, stop, err := launchAsToken(primary, exe, nil, []string{"NIGAFIY_TEST_HELPER=1"}, nil)
	if err != nil {
		t.Fatalf("CreateProcessAsUser: %v", err)
	}
	defer stop()
	c := desktop.NewHelperClient(rwc)
	if err := c.Ping(); err != nil {
		t.Fatalf("ping over the helper's pipes: %v", err)
	}
	info := c.Info()
	if info.Mode != "session_helper" || info.Backend == "" {
		t.Fatalf("helper info %+v", info)
	}
	displays, err := c.Displays()
	if err != nil || len(displays) == 0 {
		t.Fatalf("displays from the helper: %v %v", displays, err)
	}
	t.Logf("helper answered: backend %s, %d display entries", info.Backend, len(displays))
	stop()
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the helper did not go away after stop")
	}
}

func TestWTSLauncherOutsideTheServiceSaysWhy(t *testing.T) {
	if IsPrivileged() && InService() {
		t.Skip("running as a service")
	}
	l := &WTSLauncher{Exe: `C:\nonexistent.exe`}
	_, _, err := l.Launch(context.Background())
	if err == nil {
		t.Fatal("WTSQueryUserToken should be refused outside LocalSystem")
	}
	if !strings.Contains(err.Error(), "signed in") && !strings.Contains(err.Error(), "console") {
		t.Fatalf("unhelpful error: %v", err)
	}
	if l.Stale() {
		t.Fatal("a launcher that never started a helper is not stale")
	}
}

func TestStateDirectoryIsLockedToSystemAndAdministrators(t *testing.T) {
	dir := t.TempDir() + `\state`
	// Give the directory back before t.TempDir removes it (registered after, so it runs first).
	t.Cleanup(func() {
		sd, _ := windows.SecurityDescriptorFromString("D:(A;OICI;FA;;;WD)")
		dacl, _, _ := sd.DACL()
		_ = windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
	})
	if err := PrepareStateDir(dir); err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	s := sd.String()
	if !strings.HasPrefix(s, "D:P") || !strings.Contains(s, ";;;SY)") || !strings.Contains(s, ";;;BA)") {
		t.Fatalf("state dir ACL %s", s)
	}
	for _, other := range []string{";;;BU)", ";;;WD)", ";;;AU)", ";;;IU)"} {
		if strings.Contains(s, other) {
			t.Fatalf("state dir ACL grants %s: %s", other, s)
		}
	}
}

func TestInstallNeedsAnElevatedPrompt(t *testing.T) {
	if IsPrivileged() {
		t.Skip("this prompt is elevated")
	}
	if err := Install(Spec{Name: "NigafiyEndpointAgentTest", Exe: `C:\x.exe`}, false); err != ErrNotPrivileged {
		t.Fatalf("install without elevation: %v", err)
	}
	if err := Uninstall("NigafiyEndpointAgentTest"); err != ErrNotPrivileged {
		t.Fatalf("uninstall without elevation: %v", err)
	}
}

// Registers and removes a real (never started) service. Opt-in: an elevated prompt and
// NIGAFIY_TEST_SERVICE_INSTALL=1, because it changes this computer's service list.
func TestInstallAndUninstallARealService(t *testing.T) {
	if os.Getenv("NIGAFIY_TEST_SERVICE_INSTALL") != "1" {
		t.Skip("set NIGAFIY_TEST_SERVICE_INSTALL=1 in an elevated prompt to register a real test service")
	}
	if !IsPrivileged() {
		t.Fatal("NIGAFIY_TEST_SERVICE_INSTALL=1 needs an elevated prompt")
	}
	const name = "NigafiyEndpointAgentTest"
	exe, _ := os.Executable()
	args := []string{"run", "-service-name", name, "-server", "http://127.0.0.1:4162", "-state-dir", `C:\ProgramData\Nigafiy\EndpointAgentTest`, "-allow-insecure-http"}
	if err := Install(Spec{Name: name, Exe: exe, Args: args}, false); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Uninstall(name) })
	if err := Install(Spec{Name: name, Exe: exe, Args: args}, false); err == nil {
		t.Fatal("a second install of the same name must be refused")
	}
	m, err := mgr.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Config()
	s.Close()
	if err != nil {
		t.Fatal(err)
	}
	if c.DisplayName != DisplayName || c.StartType != mgr.StartAutomatic || !c.DelayedAutoStart || !strings.Contains(c.BinaryPathName, " run -service-name "+name) || c.ServiceStartName != "LocalSystem" {
		t.Fatalf("service config %+v", c)
	}
	if err := Uninstall(name); err != nil {
		t.Fatal(err)
	}
	if s, err := m.OpenService(name); err == nil {
		s.Close()
		t.Fatal("service still registered after uninstall")
	}
}
