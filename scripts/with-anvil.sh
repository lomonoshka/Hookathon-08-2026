#!/usr/bin/env bash
#
# Runs a command against a local anvil fork of Base.
#
# Hardhat's own fork hits public Base endpoints hard enough to get thrown off them (403/408
# partway through a run). anvil sits in front: it throttles requests, retries, and caches
# forked state on disk, which also makes repeated runs fast.
#
#   ./scripts/with-anvil.sh hardhat test test/base-fork/... --network localhost
#
# Anvil state is discarded on exit — fork tests deploy the plugin and create the pool, and a
# reused node makes the second run fail on state left by the first.

set -euo pipefail

if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.env
	set +a
fi

: "${ETH_NODE_URI_BASE_MAINNET:?ETH_NODE_URI_BASE_MAINNET is required (a Base RPC endpoint)}"

PORT="${ANVIL_PORT:-8545}"
ENDPOINT="http://127.0.0.1:${PORT}"

command -v anvil >/dev/null 2>&1 || {
	echo "error: anvil not found — install Foundry (https://getfoundry.sh)" >&2
	exit 127
}

rpc_up() {
	curl -sf -m 2 -X POST -H 'Content-Type: application/json' \
		--data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
		"$ENDPOINT" 2>/dev/null | grep -q '"result"'
}

block_number() {
	curl -sf -m 5 -X POST -H 'Content-Type: application/json' \
		--data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
		"$ENDPOINT" | sed -n 's/.*"result":"\(0x[0-9a-f]*\)".*/\1/p'
}

if rpc_up; then
	echo "error: something is already listening on ${ENDPOINT}." >&2
	echo "       Stop it, or set ANVIL_PORT to a free port." >&2
	exit 1
fi

FORK_ARGS=(
	--fork-url "$ETH_NODE_URI_BASE_MAINNET"
	--port "$PORT"
	--silent
	--retries "${ANVIL_RETRIES:-10}"
	--timeout "${ANVIL_TIMEOUT_MS:-45000}"
	--compute-units-per-second "${ANVIL_CUPS:-100}"
	--gas-limit 60000000
	--base-fee 0
)

# Foundry caches forked state per (chain, block) under ~/.foundry/cache/rpc, so pinning makes
# the second and later runs read from disk instead of re-fetching. Left unset, every run forks a
# fresh head and the cache is dead.
if [ -n "${BASE_FORK_BLOCK_NUMBER:-}" ]; then
	FORK_ARGS+=(--fork-block-number "$BASE_FORK_BLOCK_NUMBER")
else
	echo "warning: BASE_FORK_BLOCK_NUMBER is unset — each run forks a fresh head, so the RPC cache" >&2
	echo "         cannot help and a public endpoint may rate-limit." >&2
fi

# Redirect anvil's streams: inheriting stdout makes a piped invocation hang, because anvil keeps
# the pipe open for the whole run.
ANVIL_LOG="$(mktemp "${TMPDIR:-/tmp}/anvil-base.XXXXXX")"
anvil "${FORK_ARGS[@]}" >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
cleanup() {
	kill "$ANVIL_PID" 2>/dev/null || true
	wait "$ANVIL_PID" 2>/dev/null || true
	rm -f "$ANVIL_LOG"
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 90); do
	if rpc_up; then break; fi
	kill -0 "$ANVIL_PID" 2>/dev/null || {
		echo "error: anvil exited while starting up:" >&2
		tail -20 "$ANVIL_LOG" >&2
		exit 1
	}
	sleep 1
done

rpc_up || {
	echo "error: anvil did not become ready within 90s" >&2
	tail -20 "$ANVIL_LOG" >&2
	exit 1
}

echo "anvil forking Base at block $(( $(block_number) )) on ${ENDPOINT}"

# Deliberately not `exec`: exec replaces this shell, so the EXIT trap never runs and anvil is
# orphaned — which leaves the port held and breaks the next invocation.
set +e
npx "$@"
STATUS=$?
set -e
exit "$STATUS"
