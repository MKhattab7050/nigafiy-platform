//go:build !windows

package sas

func policyValue() (uint32, bool, error) { return 0, false, nil }

func send() error {
	return &Refusal{Code: CodeUnsupported, Message: "the Secure Attention Sequence exists on Windows only"}
}
