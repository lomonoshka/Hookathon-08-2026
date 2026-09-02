// Regenerates src/data/mainnetPoolStats.json from real Base mainnet chain data.
//
// The pool documented in the access registry (poolId 0x636f...283) is a dead
// GenericToken/GenericToken factory test with zero real swaps — confirmed by an
// exhaustive eth_getLogs scan of its full lifetime. The pool below is a real,
// live EURC/USDC pool on Base mainnet, minted via HomelanderPluginV4Factory.
//
// Run: node scripts/fetchMainnetPoolStats.mjs
import { createPublicClient, http, formatUnits } from "viem";
import { base } from "viem/chains";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RPC_URL = "https://mainnet.base.org";
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";

const EURC = { address: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", symbol: "EURC", decimals: 6 };
const USDC = { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 };

// Each pool's Initialize block was found via a factory-txlist trace (not from chain
// genesis) — that's what makes a full rescan feasible on a public RPC.
const POOLS = [
	{
		poolId: "0x862c1adf56ba8fa642e57d2565733c0c005827946e300875d9decb836b3fafbc",
		initBlock: 47100738n,
		hooks: "0xcc05a232b1ff40427a4bd50a19e2255ae0fa10c0",
		hooksKind: "HomelanderPluginV4Factory beacon-proxy (per-pool plugin instance)",
		currency0: EURC,
		currency1: USDC,
		tickSpacing: 60,
	},
];

const swapEventAbi = [
	{
		type: "event",
		name: "Swap",
		inputs: [
			{ indexed: true, name: "id", type: "bytes32" },
			{ indexed: true, name: "sender", type: "address" },
			{ indexed: false, name: "amount0", type: "int128" },
			{ indexed: false, name: "amount1", type: "int128" },
			{ indexed: false, name: "sqrtPriceX96", type: "uint160" },
			{ indexed: false, name: "liquidity", type: "uint128" },
			{ indexed: false, name: "tick", type: "int24" },
			{ indexed: false, name: "fee", type: "uint24" },
		],
	},
];

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

// mainnet.base.org caps eth_getLogs at a 10,000-block range per call.
const CHUNK = 10_000n;

async function scanSwaps(poolId, fromBlock, latest) {
	const allLogs = [];
	let from = fromBlock;
	let chunkIndex = 0;
	const totalChunks = Number((latest - fromBlock) / CHUNK) + 1;
	while (from <= latest) {
		const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
		const logs = await client.getLogs({
			address: POOL_MANAGER,
			event: swapEventAbi[0],
			args: { id: poolId },
			fromBlock: from,
			toBlock: to,
		});
		allLogs.push(...logs);
		chunkIndex += 1;
		if (chunkIndex % 50 === 0) {
			console.error(`  progress: ${chunkIndex}/${totalChunks} chunks (${allLogs.length} swaps so far)`);
		}
		from = to + 1n;
	}
	return allLogs;
}

function bucketByWeek(logs, blockTimestamps, currency0, currency1) {
	const buckets = new Map();
	for (const log of logs) {
		const ts = blockTimestamps.get(log.blockNumber);
		const weekStart = Math.floor(ts / (7 * 86400)) * 7 * 86400;
		const key = String(weekStart);
		const amount0 = log.args.amount0 < 0n ? -log.args.amount0 : log.args.amount0;
		const amount1 = log.args.amount1 < 0n ? -log.args.amount1 : log.args.amount1;
		const existing = buckets.get(key) ?? { weekStartTs: weekStart, swapCount: 0, volume0: 0n, volume1: 0n };
		existing.swapCount += 1;
		existing.volume0 += amount0;
		existing.volume1 += amount1;
		buckets.set(key, existing);
	}
	return [...buckets.values()]
		.sort((a, b) => a.weekStartTs - b.weekStartTs)
		.map((b) => ({
			weekStartTs: b.weekStartTs,
			weekStartIso: new Date(b.weekStartTs * 1000).toISOString().slice(0, 10),
			swapCount: b.swapCount,
			volume0: Number(formatUnits(b.volume0, currency0.decimals)),
			volume1: Number(formatUnits(b.volume1, currency1.decimals)),
		}));
}

async function scanPool(poolConfig, latest) {
	console.error(`Scanning real Base mainnet Swap events for ${poolConfig.currency0.symbol}/${poolConfig.currency1.symbol}...`);
	const logs = await scanSwaps(poolConfig.poolId, poolConfig.initBlock, latest);
	console.error(`  found ${logs.length} real swaps.`);

	const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
	const blockTimestamps = new Map();
	for (const bn of uniqueBlocks) {
		const block = await client.getBlock({ blockNumber: bn });
		blockTimestamps.set(bn, Number(block.timestamp));
	}

	let total0 = 0n;
	let total1 = 0n;
	const feesSeen = new Set();
	// Value captured for LPs isn't a separate on-chain event on v1 (the hook proxy emits none of
	// its own — confirmed by a full-lifetime eth_getLogs scan) — the real, honest proxy is the fee
	// revenue actually collected at each dynamic-fee tier, computed straight from Swap events:
	// feeUsd = volume-at-that-tier (currency1/USDC side, ~$1 pegged like currency0/EURC) × feePips.
	let capturedValueUsd = 0;
	for (const log of logs) {
		const amount0 = log.args.amount0 < 0n ? -log.args.amount0 : log.args.amount0;
		const amount1 = log.args.amount1 < 0n ? -log.args.amount1 : log.args.amount1;
		total0 += amount0;
		total1 += amount1;
		feesSeen.add(log.args.fee);
		const swapUsd = Number(formatUnits(amount1, poolConfig.currency1.decimals));
		capturedValueUsd += swapUsd * (Number(log.args.fee) / 1_000_000);
	}

	const timestamps = logs.map((l) => blockTimestamps.get(l.blockNumber));
	const firstTs = timestamps.length ? Math.min(...timestamps) : null;
	const lastTs = timestamps.length ? Math.max(...timestamps) : null;

	return {
		poolId: poolConfig.poolId,
		poolManager: POOL_MANAGER,
		hooks: poolConfig.hooks,
		hooksKind: poolConfig.hooksKind,
		currency0: poolConfig.currency0,
		currency1: poolConfig.currency1,
		dynamicFee: true,
		tickSpacing: poolConfig.tickSpacing,
		scan: { fromBlock: poolConfig.initBlock.toString(), toBlock: latest.toString(), rpcUrl: RPC_URL },
		stats: {
			swapCount: logs.length,
			totalVolume0: Number(formatUnits(total0, poolConfig.currency0.decimals)),
			totalVolume1: Number(formatUnits(total1, poolConfig.currency1.decimals)),
			observedFeePips: [...feesSeen].map((f) => Number(f)),
			capturedValueUsd: Number(capturedValueUsd.toFixed(2)),
			firstSwapIso: firstTs ? new Date(firstTs * 1000).toISOString() : null,
			lastSwapIso: lastTs ? new Date(lastTs * 1000).toISOString() : null,
		},
		weeklyBuckets: bucketByWeek(logs, blockTimestamps, poolConfig.currency0, poolConfig.currency1),
	};
}

async function main() {
	const latest = await client.getBlockNumber();
	const pools = [];
	for (const poolConfig of POOLS) {
		pools.push(await scanPool(poolConfig, latest));
	}

	const output = {
		generatedAtIso: new Date().toISOString(),
		chain: { id: base.id, name: "Base" },
		pools,
	};

	const outPath = join(__dirname, "..", "src", "data", "mainnetPoolStats.json");
	writeFileSync(outPath, JSON.stringify(output, null, 2));
	console.error(`Wrote ${outPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
