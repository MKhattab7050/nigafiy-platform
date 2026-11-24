package desktop

import (
	"errors"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
)

// openURL opens an http(s) address in the person's default browser (ToolOpenURL). The agent only
// ever sends pages of its own server; anything that is not a plain http(s) URL is refused here too.
func openURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || strings.ContainsAny(raw, " \"'\r\n\t`") {
		return errors.New("only an http(s) address of the Nigafiy server can be opened")
	}
	var c *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		c = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", u.String()) // #nosec G204 -- validated http(s) URL
	case "darwin":
		c = exec.Command("open", u.String()) // #nosec G204 -- validated http(s) URL
	default:
		c = exec.Command("xdg-open", u.String()) // #nosec G204 -- validated http(s) URL
	}
	if err := c.Start(); err != nil {
		return err
	}
	go func() { _ = c.Wait() }()
	return nil
}
