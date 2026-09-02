import mainnetPoolStats from "@/data/mainnetPoolStats.json";

interface TokenMeta {
	address: string;
	symbol: string;
	decimals: number;
}

interface WeeklyBucket {
	weekStartTs: number;
	weekStartIso: string;
	swapCount: number;
	volume0: number;
	volume1: number;
}

interface PoolStats {
	poolId: string;
	hooks: string;
	hooksKind: string;
	currency0: TokenMeta;
	currency1: TokenMeta;
	tickSpacing: number;
	stats: {
		swapCount: number;
		totalVolume0: number;
		totalVolume1: number;
		observedFeePips: number[];
		capturedValueUsd: number;
		firstSwapIso: string | null;
		lastSwapIso: string | null;
	};
	scan: { fromBlock: string; toBlock: string; rpcUrl: string };
	weeklyBuckets: WeeklyBucket[];
}

// Small realistic swap counts on some pools mean totals can be fractions of a token — round to
// whole units for stablecoins (thousands of dollars), but keep decimal precision for ETH so a
// genuinely real amount doesn't silently render as "0".
function formatAmount(n: number, symbol: string): string {
	if (symbol === "ETH") return n.toFixed(4);
	if (n > 0 && n < 1) return n.toFixed(4);
	return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function PoolCard({ pool }: { pool: PoolStats }) {
	const { stats, weeklyBuckets } = pool;
	const maxWeekVolume = Math.max(1, ...weeklyBuckets.map((w) => w.volume1));

	return (
		<section className="glass-panel p-5 space-y-5">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<h2 className="label-caps">
					Real Base mainnet pool — {pool.currency0.symbol}/{pool.currency1.symbol}
				</h2>
				<span className="text-xs text-neutral-500">Base (chain 8453) · live production</span>
			</div>

			<div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
				<div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
					<div className="label-caps mb-1">Real swaps</div>
					<div className="stat-number text-2xl">{stats.swapCount.toLocaleString()}</div>
				</div>
				<div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
					<div className="label-caps mb-1">{pool.currency0.symbol} volume</div>
					<div className="stat-number text-2xl">{formatAmount(stats.totalVolume0, pool.currency0.symbol)}</div>
				</div>
				<div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
					<div className="label-caps mb-1">{pool.currency1.symbol} volume</div>
					<div className="stat-number text-2xl">{formatAmount(stats.totalVolume1, pool.currency1.symbol)}</div>
				</div>
			</div>

			{weeklyBuckets.length > 0 && (
				<div className="space-y-2">
					<div className="flex items-end gap-1 h-28">
						{weeklyBuckets.map((w) => (
							<div key={w.weekStartTs} className="h-full flex-1 flex flex-col items-center justify-end gap-1 group relative">
								<div
									className="w-full bg-sky-500/70 group-hover:bg-sky-400 rounded-t transition-colors"
									style={{ height: `${Math.max(4, (w.volume1 / maxWeekVolume) * 100)}%` }}
								/>
								<div className="absolute bottom-full mb-1 hidden group-hover:block text-[10px] bg-neutral-900 border border-neutral-700 rounded px-2 py-1 whitespace-nowrap z-10">
									{w.weekStartIso}: {formatAmount(w.volume1, pool.currency1.symbol)} {pool.currency1.symbol} · {w.swapCount} swaps
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			<div className="text-xs text-neutral-600 border-t border-white/10 pt-3 space-y-1 break-all">
				<p>Pool ID <span className="font-mono">{pool.poolId}</span></p>
				<p>
					hook{" "}
					<a
						href={`https://base.blockscout.com/address/${pool.hooks}`}
						target="_blank"
						rel="noreferrer"
						className="font-mono text-neutral-400 hover:text-neutral-200"
					>
						{pool.hooks}
					</a>
				</p>
			</div>
		</section>
	);
}

export function MainnetPoolStats() {
	const { pools } = mainnetPoolStats as unknown as { pools: PoolStats[] };

	return (
		<div className="space-y-4">
			{pools.map((pool) => (
				<PoolCard key={pool.poolId} pool={pool} />
			))}
		</div>
	);
}
