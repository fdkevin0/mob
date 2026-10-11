#!/usr/bin/env bash
# Verifies the container sandbox on this machine (macOS or Linux): the runtime
# CLI through `mob container`, then the model's sandbox tool through
# `mob serve --demo`. Prints PASS/FAIL per check and keeps the work directory
# when anything fails.
#
#   scripts/verify-sandbox.sh                # builds mob from this checkout
#   MOB=/path/to/mob IMAGE=alpine:3.20 PORT=8799 scripts/verify-sandbox.sh
#   MOB_SANDBOX_RUNTIME=containerd scripts/verify-sandbox.sh
set -u

IMAGE=${IMAGE:-alpine:3.20}
PORT=${PORT:-8799}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# A space in the path catches quoting mistakes; real data dirs often have one
# (~/Library/Application Support/mob).
WORK=$(cd "$(mktemp -d)" && pwd -P)/"mob sandbox"
mkdir -p "$WORK"
TOKEN=$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 40)
SERVE_PID=
FAILED=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2" | head -c 2000; FAILED=$((FAILED + 1)); }
check() { # check NAME HAYSTACK NEEDLE...
	local name=$1 hay=$2; shift 2
	for needle in "$@"; do
		case $hay in *"$needle"*) ;; *) fail "$name" "missing '$needle' in: $hay"; return 1 ;; esac
	done
	pass "$name"
}
cleanup() {
	[ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null
	if [ "$FAILED" -eq 0 ]; then rm -rf "$(dirname "$WORK")"; else echo "Kept for inspection: $WORK"; fi
}
trap cleanup EXIT

echo "== Environment"
uname -a
case $(uname -s) in
Darwin) sw_vers; RUNTIME=${MOB_SANDBOX_RUNTIME:-apple} ;;
*) RUNTIME=${MOB_SANDBOX_RUNTIME:-containerd} ;;
esac
case $RUNTIME in
apple) CLI=container; LIST="container list --all" ;;
containerd) CLI=nerdctl; LIST="nerdctl --namespace mob ps -a" ;;
*) echo "Unsupported runtime for this script: $RUNTIME"; exit 2 ;;
esac
command -v "$CLI" >/dev/null || { echo "$CLI is not on PATH"; exit 2; }
"$CLI" --version 2>&1 | head -1

if [ -z "${MOB:-}" ]; then
	echo "== Build"
	MOB=$WORK/bin/mob
	(cd "$ROOT" && go build -o "$MOB" ./cmd/mob) || { echo "build failed"; exit 2; }
fi
"$MOB" --version
export MOB_CONFIG=$WORK/config.yaml MOB_SANDBOX_RUNTIME=$RUNTIME
: >"$MOB_CONFIG"
chmod 600 "$MOB_CONFIG"

echo "== mob container"
out=$("$MOB" container status 2>&1) && check "container status" "$out" "Ready." || fail "container status" "$out"
out=$("$MOB" container pull "$IMAGE" 2>&1) && pass "container pull $IMAGE" || fail "container pull $IMAGE" "$out"
mkdir -p "$WORK/host"
echo hello >"$WORK/host/in.txt"
out=$("$MOB" container run -v "$WORK/host:/work" -w /work -e GREETING=hi "$IMAGE" sh -c 'echo $GREETING; cat in.txt; echo out > out.txt' 2>&1)
check "run: env, bind mount, workdir" "$out" hi hello
[ "$(cat "$WORK/host/out.txt" 2>/dev/null)" = out ] && pass "run: container writes reach the host" || fail "run: container writes reach the host" "$(ls -la "$WORK/host")"
out=$("$MOB" container run "$IMAGE" sh -c 'exit 3' 2>&1)
check "run: exit status" "$out" "status 3"
# read rather than cat: nerdctl 2.1 does not pass stdin's EOF on to the container.
out=$(echo piped | "$MOB" container run -i "$IMAGE" sh -c 'read l; echo got-$l' 2>&1)
check "run: stdin with -i" "$out" got-piped

echo "== Sandbox tool through mob serve --demo"
cat >"$MOB_CONFIG" <<EOF
addr: 127.0.0.1:$PORT
demo: true
data_dir: '$WORK/data'
state_dir: '$WORK/state'
sandbox:
  enabled: true
  image: $IMAGE
EOF
MOB_TOKEN=$TOKEN "$MOB" serve >"$WORK/serve.log" 2>&1 &
SERVE_PID=$!
API=http://127.0.0.1:$PORT/api
for _ in $(seq 50); do curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "$API/config" && break; sleep 0.2; done
ID=$(curl -s -XPOST -H "Authorization: Bearer $TOKEN" "$API/conversations" | sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p')
[ -n "$ID" ] || { fail "service started" "$(cat "$WORK/serve.log")"; exit 1; }
pass "service started, conversation $ID"
chat() { # chat COMMAND: one turn; prints the tool events. Runs in subshells, so no counters.
	curl -s -N -XPOST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$API/chat" \
		-d "{\"id\":\"$ID\",\"text\":\"/sandbox $1\",\"requestId\":\"verify-$RANDOM$RANDOM\"}" | grep '"type":"tool-'
}
out=$(chat 'echo kept > note.txt; echo gone > /tmp/marker; id -u; pwd')
check "tool: runs without approval in /workspace" "$out" tool-output-available '"exitCode":0' '/workspace'
out=$(chat 'cat note.txt; cat /tmp/marker 2>&1; ls /Users /home 2>&1')
check "tool: workspace persists, the rest is discarded" "$out" kept 'No such file'
[ "$(cat "$WORK/data/sandbox/$ID/note.txt" 2>/dev/null)" = kept ] && pass "tool: workspace is data_dir/sandbox/<id> on the host" || fail "tool: workspace on the host" "$(ls -laR "$WORK/data/sandbox" 2>&1)"
out=$(chat 'exit 3')
check "tool: nonzero exit is a result" "$out" '"exitCode":3'
out=$(chat 'yes x | head -c 40000')
check "tool: output capped" "$out" '"truncated":true'

# Stopping the turn must remove the running container.
chat 'sleep 600' >/dev/null &
CHAT_PID=$!
sleep 8
running=$($LIST 2>&1 | grep -c 'mob-[0-9a-f]\{16\}')
curl -s -XPOST -H "Authorization: Bearer $TOKEN" "$API/conversations/$ID/stop" >/dev/null
wait "$CHAT_PID" 2>/dev/null
sleep 3
left=$($LIST 2>&1 | grep 'mob-[0-9a-f]\{16\}')
if [ "$running" -ge 1 ] && [ -z "$left" ]; then pass "stop: running container removed"; else fail "stop: running container removed" "running before stop: $running; left after: $left"; fi

echo "== $FAILED failed"
[ "$FAILED" -eq 0 ]
