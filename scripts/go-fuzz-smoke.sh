#!/usr/bin/env bash
# Short run of every native Go fuzz target (CI smoke; also usable locally).
# Usage: bash scripts/go-fuzz-smoke.sh [fuzztime]   (default 30s per target)
# The committed seed corpora (f.Add and testdata/fuzz/<Target>/) already run in plain `go test`;
# this adds a bounded random search on top. A failing input is written by Go to
# <package>/testdata/fuzz/<Target>/ : commit it with the fix as a regression seed.
set -u
fuzztime="${1:-30s}"
root="$(cd "$(dirname "$0")/.." && pwd)"

# module directory | package | fuzz target
targets=(
  "collectors/lan-collector|./internal/dnsfilter|FuzzHandle"
  "collectors/lan-collector|./internal/dnsfilter|FuzzParseHosts"
  "collectors/lan-collector|./internal/dnsfilter|FuzzReadTCP"
  "collectors/lan-collector|./internal/identify|FuzzParseMDNS"
  "collectors/lan-collector|./internal/identify|FuzzParseSSDP"
  "collectors/lan-collector|./internal/identify|FuzzParseDescription"
  "collectors/lan-collector|./internal/identify|FuzzParseNBStat"
  "collectors/lan-collector|./internal/identify|FuzzClean"
  "collectors/lan-collector|./internal/dhcp|FuzzParseClient"
  "collectors/lan-collector|./internal/mndp|FuzzParse"
  "collectors/lan-collector|./internal/smart|FuzzParseOffer"
  "collectors/lan-collector|./internal/smart|FuzzParseSSDPLocation"
  "collectors/lan-collector|./internal/smart|FuzzParseIGDDescription"
  "collectors/lan-collector|./internal/smart|FuzzParseSOAPFields"
  "collectors/lan-collector|./internal/smart|FuzzSecurityFromIEs"
  "agents/endpoint-agent|./internal/wsclient|FuzzRead"
  "agents/endpoint-agent|./internal/wsclient|FuzzDial"
)

# Every fuzz target in the Go modules must be listed above (a new one must not be skipped silently).
declared=$(cd "$root" && grep -rhoE '^func Fuzz[A-Za-z0-9_]+\(f \*testing\.F\)' --include='*_test.go' \
  collectors/lan-collector agents/endpoint-agent engine | wc -l)
if [ "$declared" -ne "${#targets[@]}" ]; then
  echo "scripts/go-fuzz-smoke.sh lists ${#targets[@]} fuzz targets but the Go modules declare $declared: update the list"
  exit 1
fi

failed=()
for t in "${targets[@]}"; do
  IFS='|' read -r mod pkg name <<<"$t"
  echo "::group::$mod $pkg $name ($fuzztime)"
  if ! (cd "$root/$mod" && go test -run '^$' -fuzz "^${name}\$" -fuzztime "$fuzztime" "$pkg"); then
    failed+=("$mod $pkg $name")
  fi
  echo "::endgroup::"
done

if ((${#failed[@]})); then
  printf 'fuzz target failed: %s\n' "${failed[@]}"
  exit 1
fi
echo "all ${#targets[@]} fuzz targets passed ($fuzztime each)"
