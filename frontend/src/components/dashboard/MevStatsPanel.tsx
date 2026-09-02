"use client";

import { useEffect, useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import { addresses, demoMevxExecutorAbi, poolManagerSwapEventAbi } from "@/lib/contracts";

interface CaptureEntry {
	blockNumber: bigint;
	txHash: Hex;
	profitToken: Address;
	profit: bigint;
}

// Same best-effort lookback window as FeeHistory.tsx — public Sepolia RPC endpoints commonly
// cap/rate-limit very wide eth_getLogs ranges, so this scans a bounded recent window (~5-6 days
// at a 12s block time) rather than from genesis.
const LOOKBACK_BLOCKS = 40_000n;
const MAX_ENTRIES = 15;

function tokenMeta(token: Address): { symbol: string; decimals: number } {
	if (token.toLowerCase() === addresses.weth.toLowerCase()) return { symbol: "WETH", decimals: 18 };
	if (token.toLowerCase() === addresses.usdc.toLowerCase()) return { symbol: "USDC", decimals: 6 };
	// Defensive fallback for a profit token we don't otherwise recognize — shouldn't happen in
	// this demo (only WETH/USDC pools exist), but avoids guessing decimals wrong.
	return { symbol: `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: 18 };
}

function formatAmount(amount: bigint, decimals: number): string {
	return Number(formatUnits(amount, decimals)).toFixed(decimals <= 6 ? 2 : 5);
}

export function MevStatsPanel({ poolId }: { poolId: Hex }) {
	const publicClient = usePublicClient();
	const [entries, setEntries] = useState<CaptureEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!publicClient) return;
		let cancelled = false;

		async function load() {
			setLoading(true);
			try {
				const latestBlock = await publicClient!.getBlockNumber();
				const fromBlock = latestBlock > LOOKBACK_BLOCKS ? latestBlock - LOOKBACK_BLOCKS : 0n;
				// ArbitrageExecuted carries no hook/pool identifier of its own — this executor is
				// shared across every pool that's ever been authorized on it (showcase and every
				// wizard-deployed pool alike), so its logs alone can't tell which pool a capture
				// belongs to. The only real fix is cross-referencing: a capture that happened for
				// THIS pool always fires inside the same transaction as a Swap event carrying THIS
				// pool's id — so fetch both logs and keep only executor events whose transaction
				// hash also appears among this pool's own Swap transactions.
				const [captureLogs, poolSwapLogs] = await Promise.all([
					publicClient!.getLogs({
						address: addresses.demoMevxExecutor,
						event: demoMevxExecutorAbi[0],
						fromBlock,
						toBlock: "latest",
					}),
					publicClient!.getLogs({
						address: addresses.poolManager,
						event: poolManagerSwapEventAbi[0],
						args: { id: poolId },
						fromBlock,
						toBlock: "latest",
					}),
				]);
				if (cancelled) return;
				const poolTxHashes = new Set(poolSwapLogs.map((log) => log.transactionHash));
				const parsed = captureLogs
					.filter((log) => log.transactionHash && poolTxHashes.has(log.transactionHash))
					.map((log) => ({
						blockNumber: log.blockNumber ?? 0n,
						txHash: log.transactionHash ?? ("0x" as Hex),
						profitToken: (log.args.profitToken ?? ("0x0000000000000000000000000000000000000000" as Address)) as Address,
						// `profit` is uint256 — viem decodes it as bigint (unlike the uint24/uint8 fields
						// read elsewhere in this app; see DashboardContent.tsx for the full
						// uint8..uint48-vs-uint56+ number/bigint split that matters for this codebase).
						profit: (log.args.profit ?? 0n) as bigint,
					}));
				setEntries(parsed);
				setError(null);
			} catch (err) {
				if (!cancelled) setError((err as Error).message);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}

		load();
		const interval = setInterval(load, 10_000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [publicClient, poolId]);

	const totals = new Map<string, { token: Address; sum: bigint }>();
	for (const e of entries ?? []) {
		const key = e.profitToken.toLowerCase();
		const existing = totals.get(key);
		if (existing) existing.sum += e.profit;
		else totals.set(key, { token: e.profitToken, sum: e.profit });
	}
	const totalsList = [...totals.values()];
	const recent = entries ? [...entries].reverse().slice(0, MAX_ENTRIES) : [];

	const summaryLine =
		entries && totalsList.length > 0
			? `Total MEV captured: ${totalsList
					.map((t) => {
						const meta = tokenMeta(t.token);
						return `${formatAmount(t.sum, meta.decimals)} ${meta.symbol}`;
					})
					.join(" · ")} across ${entries.length} capture${entries.length === 1 ? "" : "s"}`
			: null;

	return (
		<section className="glass-panel p-5 space-y-3">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<h2 className="label-caps">MEV captured by this hook</h2>
				{loading && <span className="text-xs text-neutral-500">Refreshing…</span>}
			</div>

			{error && (
				<p className="text-xs text-neutral-500">
					History unavailable ({error}) — this is a nice-to-have, not required to use the dashboard.
				</p>
			)}

			{!error && entries && entries.length === 0 && (
				<p className="text-xs text-neutral-500">
					No arbitrage captured yet — try creating a price gap between Pool A and Pool B below.
				</p>
			)}

			{!error && entries && entries.length > 0 && (
				<>
					<p className="stat-number text-2xl text-emerald-300">{summaryLine}</p>
					<ul className="text-xs text-neutral-500 space-y-1 max-h-40 overflow-y-auto">
						{recent.map((e, i) => {
							const meta = tokenMeta(e.profitToken);
							return (
								<li key={`${e.txHash}-${i}`} className="flex justify-between gap-3 font-mono">
									<span>block {e.blockNumber.toString()}</span>
									<a
										href={`https://sepolia.etherscan.io/tx/${e.txHash}`}
										target="_blank"
										rel="noreferrer"
										className="text-neutral-400 hover:text-neutral-200 truncate"
									>
										{e.txHash.slice(0, 10)}…
									</a>
									<span className="text-neutral-300">
										{formatAmount(e.profit, meta.decimals)} {meta.symbol}
									</span>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</section>
	);
}
