"use client";

import { formatUnits } from "viem";
import { formatFeePips } from "@/lib/feeTier";

interface StatProps {
	label: string;
	value: string;
	title?: string;
}

function Stat({ label, value, title }: StatProps) {
	return (
		<div>
			<p className="label-caps mb-1">{label}</p>
			<p className="text-sm font-mono text-neutral-200 whitespace-nowrap" title={title}>
				{value}
			</p>
		</div>
	);
}

function formatUsd(priceWei: bigint | undefined): string {
	if (priceWei === undefined) return "—";
	return `$${Number(formatUnits(priceWei, 18)).toFixed(4)}`;
}

// referencePoolPriceWei is token1(WETH)-per-token0(USDC), 18-decimal normalized — not a USD
// price. Inverting against the live USDC oracle price gives the pool's own implied WETH price
// (same formula the contract itself uses internally, `_trackedTokenUsdPrices`'s
// `!trackedTokenIsToken0` branch: `token0Usd * 1e18 / poolPrice`), directly comparable against
// the oracle's own WETH price above so the deviation driving the fee is actually visible.
const WEI = 10n ** 18n;
function poolImpliedTrackedUsd(token0UsdPriceWei: bigint | undefined, poolPriceWei: bigint | undefined): bigint | undefined {
	if (token0UsdPriceWei === undefined || poolPriceWei === undefined || poolPriceWei === 0n) return undefined;
	return (token0UsdPriceWei * WEI) / poolPriceWei;
}

// referencePoolPriceWei reads 0 until this pool's first swap ever sets it — distinct from
// formatUsd's generic "—" (still loading), so a genuinely untouched pool says why it's blank
// instead of looking broken on the dashboard's very first frame.
function formatImpliedPrice(token0UsdPriceWei: bigint | undefined, poolPriceWei: bigint | undefined): string {
	if (poolPriceWei === 0n) return "not traded yet";
	return formatUsd(poolImpliedTrackedUsd(token0UsdPriceWei, poolPriceWei));
}

export function HookStatsPanel({
	isLoading,
	isError,
	pmmEnabled,
	baseFeePips,
	maxFeePips,
	feePerDeviationBps,
	neutralThresholdBps,
	maxSpotToReferenceDeviationBps,
	token0UsdPriceWei,
	token1UsdPriceWei,
	referencePoolPriceWei,
	observationCount,
	dynamicFee,
}: {
	isLoading: boolean;
	isError: boolean;
	pmmEnabled?: boolean;
	baseFeePips?: number;
	maxFeePips?: number;
	feePerDeviationBps?: number;
	neutralThresholdBps?: number;
	maxSpotToReferenceDeviationBps?: number;
	token0UsdPriceWei?: bigint;
	token1UsdPriceWei?: bigint;
	referencePoolPriceWei?: bigint;
	observationCount?: number;
	dynamicFee?: number; // uint24 — viem decodes this as number, not bigint
}) {
	// MIN_MATURE_OBSERVATIONS in the contract — below this the reference-safety guard (which
	// clamps discounts to baseFee until the pool's own EMA has caught up) hasn't kicked in yet.
	const guardMature = observationCount !== undefined && observationCount >= 2;

	return (
		<section className="glass-panel p-5 space-y-5">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<h2 className="label-caps">Live hook state</h2>
				{isLoading && <span className="text-xs text-neutral-500">Refreshing…</span>}
			</div>

			{isError && (
				<p className="text-xs text-red-400">
					Could not read hook state — the address may not be deployed on this network yet.
				</p>
			)}

			<div className="flex items-center gap-2">
				<span
					className={`inline-block w-2.5 h-2.5 rounded-full ${pmmEnabled ? "bg-sky-400" : "bg-neutral-500"}`}
					aria-hidden
				/>
				<span className={`text-sm font-medium ${pmmEnabled ? "text-sky-300" : "text-neutral-400"}`}>
					{pmmEnabled ? "Directional oracle-deviation fee" : "PMM disabled — static fee"}
				</span>
				<span className="text-sm text-neutral-400 font-mono">
					— {formatFeePips(baseFeePips)} base
					{pmmEnabled ? ` (up to ${formatFeePips(maxFeePips)})` : ""}
				</span>
			</div>

			<p className="text-xs text-neutral-500">
				This hook charges more when a swap pushes the pool price <em>away</em> from the oracle, and less when it
				corrects back toward it — see{" "}
				<span className="text-neutral-400">Recent applied fees</span> below for what a given swap actually paid.
			</p>

			<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
				<Stat label="Base / max fee" value={`${formatFeePips(baseFeePips)} / ${formatFeePips(maxFeePips)}`} />
				<Stat
					label="Fee per deviation / neutral band"
					value={
						feePerDeviationBps !== undefined && neutralThresholdBps !== undefined
							? `${feePerDeviationBps} pips/bps · ${(neutralThresholdBps / 100).toFixed(2)}%`
							: "—"
					}
				/>
				<Stat label="Token0 (USDC) oracle price" value={formatUsd(token0UsdPriceWei)} />
				<Stat label="Token1 (WETH) oracle price" value={formatUsd(token1UsdPriceWei)} />
				<Stat
					label="Reference-safety guard"
					value={
						maxSpotToReferenceDeviationBps !== undefined
							? `±${(maxSpotToReferenceDeviationBps / 100).toFixed(2)}%`
							: "—"
					}
					title="A discount only applies once the pool's own recent-price reference has caught up to within this band — otherwise it's clamped to baseFee."
				/>
				<Stat
					label="Guard maturity"
					value={
						observationCount !== undefined
							? `${observationCount} observation${observationCount === 1 ? "" : "s"} (${guardMature ? "mature" : "warming up"})`
							: "—"
					}
				/>
				<Stat
					label="Pool's implied WETH price"
					value={formatImpliedPrice(token0UsdPriceWei, referencePoolPriceWei)}
					title="The pool's own recent trading price, converted to a USD-equivalent WETH price — compare against the oracle price above to see the deviation driving the fee."
				/>
				<Stat label="dynamicFee (raw)" value={dynamicFee !== undefined ? `0x${dynamicFee.toString(16)}` : "—"} />
			</div>
		</section>
	);
}
