package cloud

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	b := Backoff{Min: time.Second, Max: 30 * time.Second}
	prevCeiling := time.Duration(0)
	for i := 0; i < 12; i++ {
		d := b.Next()
		ceiling := min(time.Second<<i, 30*time.Second)
		if d < ceiling/2 || d > ceiling {
			t.Fatalf("attempt %d: delay %v outside [%v, %v]", i, d, ceiling/2, ceiling)
		}
		if ceiling < prevCeiling {
			t.Fatal("ceiling must not shrink")
		}
		prevCeiling = ceiling
	}
	b.Reset()
	if d := b.Next(); d > time.Second {
		t.Fatalf("after Reset the delay should be back to the minimum, got %v", d)
	}
}

func TestStatusMapping(t *testing.T) {
	status := http.StatusOK
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c, err := New(srv.URL, "", "test")
	if err != nil {
		t.Fatal(err)
	}
	c.SetCredential("ldc_x.y")

	if err := c.SendBatch(context.Background(), []byte(`{}`)); err != nil {
		t.Fatalf("200 should succeed: %v", err)
	}
	if gotAuth != "Bearer ldc_x.y" {
		t.Fatalf("credential not sent as bearer token: %q", gotAuth)
	}
	status = http.StatusUnauthorized
	if err := c.SendBatch(context.Background(), []byte(`{}`)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("401 → ErrUnauthorized, got %v", err)
	}
	status = http.StatusBadRequest
	if err := c.SendBatch(context.Background(), []byte(`{}`)); !errors.Is(err, ErrRejected) {
		t.Fatalf("400 → ErrRejected, got %v", err)
	}
	for _, s := range []int{http.StatusServiceUnavailable, http.StatusTooManyRequests, http.StatusBadGateway} {
		status = s
		err := c.SendBatch(context.Background(), []byte(`{}`))
		if err == nil || errors.Is(err, ErrUnauthorized) || errors.Is(err, ErrRejected) {
			t.Fatalf("%d must be a transient (retryable) error, got %v", s, err)
		}
	}
}

func TestCredentialDoesNotFollowRedirects(t *testing.T) {
	leaked := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			leaked = true
		}
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "", "test")
	c.SetCredential("ldc_secret.value")
	if err := c.SendBatch(context.Background(), []byte(`{}`)); err == nil {
		t.Fatal("a redirect must be treated as an error")
	}
	if leaked {
		t.Fatal("credential was sent to the redirect target")
	}
}

func TestUnreachableServerErrorOmitsURL(t *testing.T) {
	c, _ := New("http://127.0.0.1:1", "", "test")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := c.SendBatch(ctx, []byte(`{}`))
	if err == nil {
		t.Fatal("expected an error")
	}
	if errors.Is(err, ErrUnauthorized) || errors.Is(err, ErrRejected) {
		t.Fatal("connection failure must be transient")
	}
}
