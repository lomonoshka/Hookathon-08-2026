"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { usePublicClient } from "wagmi";
import { addresses, poolManagerSwapEventAbi } from "@/lib/contracts";
import { formatFeePips } from "@/lib/feeTier";

interface SwapLogEntry {
	blockNumber: bigint;
	txHash: Hex;
	feePips: number;
}

// Best-effort lookback window, not exhaustive history — public Sepolia RPC endpoints commonly
// cap/rate-limit very wide eth_getLogs ranges, so we keep this modest (~5-6 days at a 12s
// block time) rather than scanning from genesis.
const LOOKBACK_BLOCKS = 40_000n;
const MAX_ENTRIES = 25;

export function FeeHistory({ poolId }: { poolId: Hex }) {
	const publicClient = usePublicClient();
	const [entries, setEntries] = useState<SwapLogEntry[] | null>(null);
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
				// A capture triggers a second, internal Swap event on this same pool inside the same
				// transaction (DemoMevxExecutor settling the arbitrage profit) — always fee=0, not a
				// real applied fee. Both share this pool's `id`, but only the person's own swap comes
				// from PoolSwapTest (`sender`); filtering on that excludes the internal one without
				// touching anything server-side.
				const logs = await publicClient!.getLogs({
					address: addresses.poolManager,
					event: poolManagerSwapEventAbi[0],
					args: { id: poolId, sender: addresses.poolSwapTest },
					fromBlock,
					toBlock: "latest",
				});
				if (cancelled) return;
				const parsed = logs
					.map((log) => ({
						blockNumber: log.blockNumber ?? 0n,
						txHash: log.transactionHash ?? ("0x" as Hex),
						feePips: Number(log.args.fee ?? 0),
					}))
					.slice(-MAX_ENTRIES);
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

	const maxFee = entries && entries.length > 0 ? Math.max(...entries.map((e) => e.feePips), 1) : 1;

	return (
		<section className="glass-panel p-5 space-y-3">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<h2 className="label-caps">Recent applied fees</h2>
				{loading && <span className="text-xs text-neutral-500">Refreshing…</span>}
			</div>

			{error && (
				<p className="text-xs text-neutral-500">
					History unavailable ({error}) — this is a nice-to-have, not required to use the dashboard.
				</p>
			)}

			{!error && entries && entries.length === 0 && (
				<p className="text-xs text-neutral-500">No swaps recorded yet in the recent-block window.</p>
			)}

			{!error && entries && entries.length > 0 && (
				<>
					<div className="flex items-end gap-1 h-16">
						{entries.map((e, i) => (
							<div
								key={`${e.txHash}-${i}`}
								className="group relative flex-1 min-w-[6px] bg-sky-500/70 hover:bg-sky-400 rounded-t transition-colors"
								style={{ height: `${Math.max((e.feePips / maxFee) * 100, 6)}%` }}
							>
								<div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block whitespace-nowrap text-[10px] bg-neutral-800 border border-neutral-700 rounded px-1.5 py-0.5 text-neutral-200">
									{formatFeePips(e.feePips)} · block {e.blockNumber.toString()}
								</div>
							</div>
						))}
					</div>
					<ul className="text-xs text-neutral-500 space-y-1 max-h-32 overflow-y-auto">
						{[...entries].reverse().map((e, i) => (
							<li key={`${e.txHash}-row-${i}`} className="flex justify-between gap-3 font-mono">
								<span>block {e.blockNumber.toString()}</span>
								<a
									href={`https://sepolia.etherscan.io/tx/${e.txHash}`}
									target="_blank"
									rel="noreferrer"
									className="text-neutral-400 hover:text-neutral-200 truncate"
								>
									{e.txHash.slice(0, 10)}…
								</a>
								<span className="text-neutral-300">{formatFeePips(e.feePips)}</span>
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}
