"use client";

import { useMemo } from "react";
import type { Address, Hex } from "viem";
import { useReadContracts } from "wagmi";
import { addresses, demoMevxRouterAbi } from "@/lib/contracts";
import type { PoolKeyStruct } from "@/lib/poolKey";
import { PushPoolBButton } from "./PushPoolBButton";

// Same refresh cadence as HookStatsPanel's reads in DashboardContent.tsx.
const REFRESH_INTERVAL_MS = 6000;

type InitialArbCheckResult = readonly [boolean, Hex];
type ReferencePoolResult = readonly [Address, Address, number, number, Address];

export function ArbSpreadPanel({
	poolId,
	disabled,
	disabledReason,
	captureAvailable = true,
	isOwner = false,
}: {
	poolId: Hex;
	disabled?: boolean;
	disabledReason?: string;
	/** Whether this specific hook is in DemoMevxExecutor's authorized-caller set — the spread
	 * check below is real and live either way, but capture only actually executes for an
	 * authorized hook (the showcase pool, or any pool that's completed the deploy wizard's
	 * "Enable the MEV-capture demo" step). */
	captureAvailable?: boolean;
	/** This single-pool showcase only lets the project owner's wallet push Pool B — everyone
	 * else sees the live spread read (still real, still live) with no action button. */
	isOwner?: boolean;
}) {
	const routerContract = { address: addresses.demoMevxRouter, abi: demoMevxRouterAbi } as const;

	const { data, isLoading, isError } = useReadContracts({
		contracts: [
			{ ...routerContract, functionName: "initialArbCheck", args: [poolId, true] },
			{ ...routerContract, functionName: "minSpreadBps" },
			{ ...routerContract, functionName: "hasReferencePool", args: [poolId] },
			{ ...routerContract, functionName: "referencePool", args: [poolId] },
		],
		query: { refetchInterval: REFRESH_INTERVAL_MS },
	});

	// initialArbCheck returns (bool isArbPossible, bytes16 priceChange). viem decodes a fixed
	// bytesN return as a 0x hex string (never a number/bigint). DemoMevxRouter._evaluate packs
	// the spread as `bytes16(uint128(spreadBps))` — a same-bit-width int->bytes cast, which in
	// Solidity just reinterprets spreadBps's big-endian bytes directly (no shifting/padding since
	// both sides are 16 bytes). So the hex string IS spreadBps's big-endian encoding, and
	// `BigInt(priceChange)` recovers the original uint256 value exactly.
	const arbCheck = data?.[0]?.result as InitialArbCheckResult | undefined;
	const isArbPossible = arbCheck?.[0];
	const priceChangeHex = arbCheck?.[1];
	const spreadBps = priceChangeHex !== undefined ? BigInt(priceChangeHex) : undefined;

	// minSpreadBps() is a public uint256 state var — decodes as bigint (see DashboardContent.tsx
	// for the general uint8..uint48-vs-uint56+ number/bigint split this whole app relies on).
	// Both spreadBps and minSpreadBps are bigint here, so comparing/dividing them never mixes
	// bigint with number.
	const minSpreadBps = data?.[1]?.result as bigint | undefined;
	const hasReferencePool = data?.[2]?.result as boolean | undefined;

	// referencePool(bytes32) returns the PoolKey struct tuple (currency0, currency1, fee,
	// tickSpacing, hooks). fee is uint24 and tickSpacing is int24 — both decode as plain numbers,
	// not bigint, exactly like every other PoolKeyStruct field in this app (see poolKey.ts).
	const refPoolResult = data?.[3]?.result as ReferencePoolResult | undefined;
	const poolBKey: PoolKeyStruct | undefined = useMemo(() => {
		if (!refPoolResult) return undefined;
		const [currency0, currency1, fee, tickSpacing, hooks] = refPoolResult;
		return { currency0, currency1, fee, tickSpacing, hooks };
	}, [refPoolResult]);

	const spreadPct = spreadBps !== undefined ? Number(spreadBps) / 100 : null;
	const thresholdPct = minSpreadBps !== undefined ? Number(minSpreadBps) / 100 : null;
	const capturable = isArbPossible === true;

	const barPct =
		spreadBps !== undefined && minSpreadBps !== undefined && minSpreadBps > 0n
			? Math.min((Number(spreadBps) / Number(minSpreadBps)) * 100, 100)
			: 0;

	return (
		<section className="glass-panel p-5 space-y-4">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<h2 className="label-caps">Arbitrage spread (Pool A vs Pool B)</h2>
				{isLoading && <span className="text-xs text-neutral-500">Refreshing…</span>}
			</div>

			{isError && <p className="text-xs text-red-400">Could not read the router&apos;s arb-check state.</p>}

			{!isError && hasReferencePool === false && (
				<p className="text-xs text-neutral-500">
					No reference pool registered for this pool yet — the arbitrage mechanism has nothing to compare
					against.
				</p>
			)}

			{!isError && hasReferencePool && (
				<>
					<div className="flex items-center gap-2">
						<span
							className={`inline-block w-2.5 h-2.5 rounded-full ${capturable ? "bg-emerald-400" : "bg-neutral-600"}`}
							aria-hidden
						/>
						<span className={`text-sm font-medium ${capturable ? "text-emerald-300" : "text-neutral-400"}`}>
							{capturable ? "Above threshold — arbitrage-capturable" : "Below threshold — no opportunity right now"}
						</span>
					</div>

					<div className="grid grid-cols-2 gap-4 max-w-xs">
						<div>
							<p className="text-xs text-neutral-500">Current spread</p>
							<p className="text-sm font-mono text-neutral-200">{spreadPct !== null ? `${spreadPct.toFixed(2)}%` : "—"}</p>
						</div>
						<div>
							<p className="text-xs text-neutral-500">Threshold</p>
							<p className="text-sm font-mono text-neutral-200">
								{thresholdPct !== null ? `${thresholdPct.toFixed(2)}%` : "—"}
							</p>
						</div>
					</div>

					<div className="h-2 rounded bg-neutral-800 overflow-hidden max-w-xs">
						<div
							className={`h-full rounded transition-all ${capturable ? "bg-emerald-400" : "bg-sky-500/70"}`}
							style={{ width: `${Math.max(barPct, 2)}%` }}
						/>
					</div>

					{!captureAvailable && (
						<p className="text-xs text-amber-300">
							Spread detection above is real and live for this pool. Automatic capture execution isn&apos;t
							enabled for it yet though — this page enables it automatically within ~30 seconds of load
							for a freshly-deployed pool (2 on-chain confirmations). Refresh in a bit if it&apos;s been
							longer.
						</p>
					)}

					{isOwner && poolBKey && <PushPoolBButton poolBKey={poolBKey} disabled={disabled} disabledReason={disabledReason} />}
				</>
			)}
		</section>
	);
}
