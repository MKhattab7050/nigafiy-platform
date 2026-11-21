package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"

	"github.com/nigafiy/engine/internal/engine"
)

func TestServiceHandlerStopCancelsEngine(t *testing.T) {
	for _, cmd := range []svc.Cmd{svc.Stop, svc.Shutdown} {
		cancelled := make(chan struct{})
		h := &serviceHandler{run: func(ctx context.Context) error {
			<-ctx.Done()
			close(cancelled)
			time.Sleep(50 * time.Millisecond) // children stopping
			return nil
		}}
		requests := make(chan svc.ChangeRequest)
		status := make(chan svc.Status, 32)
		type result struct {
			specific bool
			code     uint32
		}
		res := make(chan result, 1)
		go func() {
			s, c := h.Execute(nil, requests, status)
			res <- result{s, c}
		}()
		if st := <-status; st.State != svc.StartPending {
			t.Fatalf("first status %v", st.State)
		}
		if st := <-status; st.State != svc.Running || st.Accepts&svc.AcceptStop == 0 || st.Accepts&svc.AcceptShutdown == 0 {
			t.Fatalf("running status %+v", st)
		}
		requests <- svc.ChangeRequest{Cmd: svc.Interrogate, CurrentStatus: svc.Status{State: svc.Running}}
		if st := <-status; st.State != svc.Running {
			t.Fatalf("interrogate answered %v", st.State)
		}
		requests <- svc.ChangeRequest{Cmd: cmd}
		if st := <-status; st.State != svc.StopPending {
			t.Fatalf("after %v: %v", cmd, st.State)
		}
		select {
		case <-cancelled:
		case <-time.After(5 * time.Second):
			t.Fatal("engine context not cancelled")
		}
		select {
		case r := <-res:
			if r.specific || r.code != 0 {
				t.Fatalf("exit %+v, want clean", r)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("handler did not return")
		}
	}
}

func TestServiceHandlerReportsEngineFailure(t *testing.T) {
	h := &serviceHandler{run: func(context.Context) error {
		return errors.Join(engine.ErrAlreadyRunning, errors.New("at 127.0.0.1:47140"))
	}}
	status := make(chan svc.Status, 8)
	specific, code := h.Execute(nil, make(chan svc.ChangeRequest), status)
	if !specific || code != exitAlreadyRunning {
		t.Fatalf("got (%v, %d), want service-specific exit %d", specific, code, exitAlreadyRunning)
	}
}
