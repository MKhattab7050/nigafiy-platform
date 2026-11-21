//go:build windows

package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// prepareCommand starts the child suspended (so it cannot start grandchildren before it is in its
// Job Object) and without a console window.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW,
	}
}

// processTree is a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: every process the child
// starts (node → postgres.exe, the API, the web server) is in it, and all of them die when the job is
// terminated or its handle is closed — including when the engine itself dies.
type processTree struct {
	mu     sync.Mutex
	job    windows.Handle
	closed bool
}

func attachTree(p *os.Process) (*processTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("SetInformationJobObject: %w", err)
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(p.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("OpenProcess: %w", err)
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("AssignProcessToJobObject: %w", err)
	}
	if err := resumeProcess(uint32(p.Pid)); err != nil {
		windows.TerminateJobObject(job, 1)
		windows.CloseHandle(job)
		return nil, err
	}
	return &processTree{job: job}, nil
}

// resumeProcess resumes the threads of a process started with CREATE_SUSPENDED.
func resumeProcess(pid uint32) error {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(snap)
	var te windows.ThreadEntry32
	te.Size = uint32(unsafe.Sizeof(te))
	resumed := 0
	for err = windows.Thread32First(snap, &te); err == nil; err = windows.Thread32Next(snap, &te) {
		if te.OwnerProcessID != pid {
			continue
		}
		th, oerr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, te.ThreadID)
		if oerr != nil {
			return fmt.Errorf("OpenThread: %w", oerr)
		}
		_, rerr := windows.ResumeThread(th)
		windows.CloseHandle(th)
		if rerr != nil {
			return fmt.Errorf("ResumeThread: %w", rerr)
		}
		resumed++
	}
	if resumed == 0 {
		return fmt.Errorf("no thread found to resume for pid %d", pid)
	}
	return nil
}

func (t *processTree) kill() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	return windows.TerminateJobObject(t.job, 1)
}

// jobAccounting is JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.
type jobAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

// active reports whether any process is still running in the job.
func (t *processTree) active() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return false
	}
	var info jobAccounting
	if err := windows.QueryInformationJobObject(t.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		return false
	}
	return info.ActiveProcesses > 0
}

// close terminates whatever is left in the job and releases it.
func (t *processTree) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return
	}
	t.closed = true
	windows.TerminateJobObject(t.job, 1)
	windows.CloseHandle(t.job)
}

// requestStop: Windows has no SIGTERM; closing stdin (done by the caller) is the stop request.
func requestStop(*os.Process) error { return nil }
