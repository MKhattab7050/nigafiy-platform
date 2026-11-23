//go:build windows

package update

import (
	"os"
	"testing"
	"time"
)

func TestStartDetachedAndWaitExit(t *testing.T) {
	pid, err := StartDetached(os.Getenv("ComSpec"), []string{"/c", "exit", "0"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	if err := WaitExit(pid, 20*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := WaitExit(os.Getpid(), 100*time.Millisecond); err == nil {
		t.Fatal("WaitExit on a running process returned nil")
	}
}

func TestRunInstallerExitCode(t *testing.T) {
	code, err := RunInstaller(os.Getenv("ComSpec"), []string{"/c", "exit", "7"})
	if err != nil || code != 7 {
		t.Fatalf("code %d err %v", code, err)
	}
}
