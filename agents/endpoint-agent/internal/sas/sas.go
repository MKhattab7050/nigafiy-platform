// Package sas sends the Secure Attention Sequence (Ctrl+Alt+Del) for an operator, the only way a
// program can: SendSAS from sas.dll, called by a service running as LocalSystem. Windows refuses it
// unless the SoftwareSASGeneration policy allows services to generate it:
//
//	HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System
//	  SoftwareSASGeneration (DWORD) = 1 (services) or 3 (services and Ease of Access programs)
//
// (Group Policy: Computer Configuration → Administrative Templates → Windows Components → Windows
// Logon Options → "Disable or enable software Secure Attention Sequence" → Enabled, Services.)
// The agent never changes that policy itself. Every refusal says why.
package sas

import "fmt"

// Refusal is why the sequence was not sent (Code is stable for the API and the UI).
type Refusal struct {
	Code    string
	Message string
}

func (r *Refusal) Error() string { return r.Message }

// Codes.
const (
	CodeNotService    = "sas_needs_service"
	CodePolicyMissing = "sas_policy_disabled"
	CodeUnsupported   = "sas_unsupported"
)

// PolicyAllowsServices reports whether a SoftwareSASGeneration value lets services send it.
func PolicyAllowsServices(value uint32, present bool) bool {
	return present && (value == 1 || value == 3)
}

// Send sends Ctrl+Alt+Del. asService: this process is the agent's Windows service (LocalSystem).
func Send(asService bool) error {
	if !asService {
		return &Refusal{Code: CodeNotService, Message: "Ctrl+Alt+Del can only be sent when the agent runs as its Windows service (nigafiy-agent install); a program in the user's session cannot generate it"}
	}
	value, present, err := policyValue()
	if err != nil {
		return &Refusal{Code: CodeUnsupported, Message: err.Error()}
	}
	if !PolicyAllowsServices(value, present) {
		return &Refusal{Code: CodePolicyMissing, Message: fmt.Sprintf("Windows does not allow services to send Ctrl+Alt+Del on this computer: set the policy SoftwareSASGeneration to 1 (HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System; now %s)", describe(value, present))}
	}
	return send()
}

func describe(v uint32, present bool) string {
	if !present {
		return "not set"
	}
	return fmt.Sprintf("%d", v)
}
