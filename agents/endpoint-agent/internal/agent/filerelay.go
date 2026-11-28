package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/nigafiy/agent/internal/control"
)

// File transfer bytes apart from the commands (docs/roadmap/2026-11-28-file-transfer-speed.md).
// The server sends an upload piece as `data_ref` (fetched here, raw) instead of base64 inside the
// command, and a download asked with `relay` sends its bytes to the server raw before the result,
// which then carries `relayed` and the checks but no bytes. The server uses this only with agents
// that list FeatureFileRelay in their poll; if sending a download's bytes fails, the result carries
// them as base64 as before.

// FeatureFileRelay is announced in every command poll.
const FeatureFileRelay = "fs_relay"

// maxRelayPiece matches the server's limit (an upload chunk is at most 2 MiB).
const maxRelayPiece = 2 << 20

// agentFeatures is what this agent tells the server it can do.
var agentFeatures = []string{FeatureFileRelay}

// fsRelayCommand runs an fs_op that uses the side channel; handled is false for any other command.
func (a *Agent) fsRelayCommand(ctx context.Context, cmd control.Command) (control.Result, bool) {
	if cmd.Kind != "fs_op" {
		return control.Result{}, false
	}
	var p map[string]any
	if err := json.Unmarshal(cmd.Payload, &p); err != nil {
		return control.Result{}, false
	}
	ref, _ := p["data_ref"].(string)
	relay, _ := p["relay"].(bool)
	switch {
	case ref != "":
		data, err := a.getRaw(ctx, "/file-data/"+url.PathEscape(ref))
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: "relay piece missing: " + err.Error()}, true
		}
		if n, ok := p["data_len"].(float64); ok && int(n) != len(data) {
			return control.Result{ID: cmd.ID, OK: false, Error: fmt.Sprintf("relay piece missing: got %d bytes, expected %d", len(data), int(n))}, true
		}
		delete(p, "data_ref")
		delete(p, "data_len")
		p["data_base64"] = base64.StdEncoding.EncodeToString(data)
		raw, err := json.Marshal(p)
		if err != nil {
			return control.Result{ID: cmd.ID, OK: false, Error: "Invalid file manager request payload"}, true
		}
		return a.deps.ExecuteCommand(ctx, control.Command{ID: cmd.ID, Kind: cmd.Kind, Payload: raw}), true
	case relay:
		res := a.deps.ExecuteCommand(ctx, cmd)
		if !res.OK || len(res.Data) == 0 {
			return res, true
		}
		var out map[string]any
		if json.Unmarshal(res.Data, &out) != nil {
			return res, true
		}
		b64, _ := out["data_base64"].(string)
		if b64 == "" {
			return res, true
		}
		data, err := base64.StdEncoding.DecodeString(b64)
		if err != nil || len(data) > maxRelayPiece {
			return res, true
		}
		if err := a.postRaw(ctx, "/file-data?command_id="+url.QueryEscape(cmd.ID), data); err != nil {
			a.log.Debug("file relay upload failed; sending the bytes in the result", "error", err.Error())
			return res, true
		}
		delete(out, "data_base64")
		out["relayed"] = true
		if raw, err := json.Marshal(out); err == nil {
			res.Data = raw
		}
		return res, true
	}
	return control.Result{}, false
}

func (a *Agent) rawRequest(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.server()+"/api/v1/agent"+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	req.Header.Set("User-Agent", "nigafiy-agent/"+a.version)
	a.mu.Lock()
	cred := a.credential
	a.mu.Unlock()
	req.Header.Set("Authorization", "Bearer "+cred)
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxRelayPiece+1))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("server returned HTTP %d", resp.StatusCode)
	}
	if len(data) > maxRelayPiece {
		return nil, errors.New("piece larger than 2 MiB")
	}
	return data, nil
}

func (a *Agent) getRaw(ctx context.Context, path string) ([]byte, error) {
	return a.rawRequest(ctx, http.MethodGet, path, nil)
}

func (a *Agent) postRaw(ctx context.Context, path string, body []byte) error {
	_, err := a.rawRequest(ctx, http.MethodPost, path, body)
	return err
}
