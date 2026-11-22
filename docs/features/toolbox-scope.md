# Toolbox scope validation

The IT toolbox (ping, traceroute, TCP port check, service port scan, DNS lookup, reverse DNS) is an
active network operation. Every target is checked against the site's authorized `network_scopes` at
BOTH layers: the API before a run is queued, and the collector on the address it is about to probe.

## The rule

| Target | ping | traceroute | reverse DNS | TCP port check | port scan | DNS lookup |
| --- | --- | --- | --- | --- | --- | --- |
| Local-kind address inside an enabled scope of the site | yes | yes | yes | yes | yes | n/a |
| Local-kind address outside every scope (or the scope is disabled) | no | no | no | no | no | n/a |
| Public internet address | yes | yes | yes | **no** | **no** | n/a |
| Host name | yes ¹ | yes ¹ | n/a | **no** ² | **no** ² | yes |
| Unspecified, broadcast, multicast, reserved (240/4, 0/8) | no | no | no | no | no | n/a |
| Loopback | only when loopback scopes are allowed (dev/test) and in scope | | | | | |

"Local-kind" = RFC 1918 private, loopback, link-local 169.254/16, CGNAT 100.64/10.

1. The API cannot know what a name resolves to, so it passes the name on; the collector resolves it
   and applies the address rule to the result (a name resolving to an out-of-scope private address is
   refused).
2. Port checks need an IPv4 address inside a scope; names are refused by the API.

Why public targets are allowed for ping/traceroute/reverse DNS: they are internet-reachability
diagnostics (5 ICMP echoes; a traceroute of at most 20 hops; one PTR query to the collector's own
resolver) and do not probe services. A port scanner never leaves the authorized private scopes, which
is what the spec's "strictly validate target IPs against authorized network_scopes" requires of
scanning. A DNS lookup of a name sends nothing to the name.

## Where

- API: `apps/api/src/modules/toolbox/queue.ts` (`assertToolScope`), used by `POST /toolbox` and by
  playbook `run_tool` steps. Refusal: HTTP 422 `out_of_scope`, nothing is queued.
- Collector: `collectors/lan-collector/internal/tools/scope.go` (`Runner.CheckTarget`), called in
  `Run` for every tool after name resolution and before any probe. The scopes come from the
  collector's own delivered configuration (`internal/agent/toolbox.go` sets `Request.InScope` from
  `authorizedPrefixes()`), never from the request payload.

## Verified

- `apps/api/tests/toolbox.test.ts`: in-scope private address for every tool; out-of-scope private
  address refused for every tool (ping included); disabled scope; public ping/traceroute/rdns allowed;
  public TCP/port scan refused; names for port checks refused; special addresses refused.
- `internal/tools/tools_test.go` `TestScopeRule`: the same matrix at the collector, and that no probe
  runs for a refused target.

Not run against a real network (no real network may be touched from this machine).
