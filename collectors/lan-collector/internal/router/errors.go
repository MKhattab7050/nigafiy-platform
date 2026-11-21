package router

import (
	"errors"
	"fmt"
	"time"
)

// Error kinds. Test with errors.Is(err, router.ErrBadCredentials) etc. Messages never contain
// passwords, keys, cookies, tokens or (encrypted) payloads.
var (
	ErrBadCredentials   = errors.New("the router rejected the user name or password")
	ErrLockedOut        = errors.New("the router has temporarily locked the account after failed logins")
	ErrSessionExpired   = errors.New("the router session expired")
	ErrSessionLimit     = errors.New("the router refused a new session (another administrator is logged in or the session limit is reached)")
	ErrUnsupported      = errors.New("not supported by this router model or firmware")
	ErrUnreachable      = errors.New("the router could not be reached")
	ErrNotAuthorized    = errors.New("the router address is outside the ranges this collector is authorized to control")
	ErrCertificate      = errors.New("the router's TLS certificate is not trusted (it matches neither the pinned fingerprint nor the system roots)")
	ErrNotFound         = errors.New("the router does not know this device")
	ErrProtocol         = errors.New("the router answered in an unexpected way")
	ErrInvalidArgument  = errors.New("invalid argument")
	ErrUnknownVendor    = errors.New("no driver for this router vendor")
	ErrRejected         = errors.New("the router refused the change")
	ErrCredentialSource = errors.New("no credentials available for this router")
)

// Error carries the kind plus context that is safe to show to an administrator.
type Error struct {
	Kind   error  // one of the Err* values above
	Op     string // what was being done, e.g. "login", "clients", "block"
	Detail string // safe, human-readable detail (never secrets or payloads)
	// RetryAfter is set for ErrLockedOut when the router says how long the lock lasts.
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	msg := e.Kind.Error()
	if e.Op != "" {
		msg = e.Op + ": " + msg
	}
	if e.Detail != "" {
		msg += " (" + e.Detail + ")"
	}
	if e.RetryAfter > 0 {
		msg += fmt.Sprintf("; try again in %s", e.RetryAfter.Round(time.Second))
	}
	return msg
}

func (e *Error) Unwrap() error { return e.Kind }

// Errorf builds an *Error. Callers must not pass secrets in the detail.
func Errorf(kind error, op, format string, args ...any) *Error {
	return &Error{Kind: kind, Op: op, Detail: fmt.Sprintf(format, args...)}
}
