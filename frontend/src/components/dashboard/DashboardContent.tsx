"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { isAddress, type Address } from "viem";
import { useAccount, useChainId, useReadContracts } from "wagmi";
import { sepolia } from "wagmi/chains";
import { addresses, demoMevxExecutorAbi, hookAbi, mockAggregatorAbi } from "@/lib/contracts";
import { buildDemoPoolKey, computePoolId } from "@/lib/poolKey";
import { defaultFeePipsFrom } from "@/lib/feeTier";
import { useIsOwner } from "@/lib/useIsOwner";
import { HookAddressHeader } from "./HookAddressHeader";
import { HookStatsPanel } from "./HookStatsPanel";
import { OneClickDemoButton } from "./OneClickDemoButton";
import { PriceShockControls } from "./PriceShockControls";
import { SwapWidget } from "./SwapWidget";
import { FeeHistory } from "./FeeHistory";
import { MevStatsPanel } from "./MevStatsPanel";
import { ArbSpreadPanel } from "./ArbSpreadPanel";

const REFRESH_INTERVAL_MS = 6000;

// pmmConfig()'s flattened positional return — see contracts.ts for why a public struct getter
// decodes this way. Every field here is uint8/16/24/32/address/bool, never bigint.
type PmmConfigResult = readonly [
	Address, // token0UsdFeed
	Address, // token1UsdFeed
	number, // token0FeedDecimals
	number, // token1FeedDecimals
	number, // baseFee
	number, // maxFee
	number, // feePerDeviationBps
	number, // neutralThresholdBps
	number, // maxOracleAge
	number, // observationWindow
	number, // minObservationAge
	number, // maxSpotToReferenceDeviationBps
	number, // maxLimitToSpotDeviationBps
	boolean, // trackedTokenIsToken0
	boolean, // enabled
];

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export function DashboardContent() {
	const searchParams = useSearchParams();
	const { isConnected } = useAccount();
	const isOwner = useIsOwner();
	const chainId = useChainId();

	const hookParam = searchParams.get("hook");
	const hasValidHookParam = !!hookParam && isAddress(hookParam);

	// The default (no `?hook=` override) pool isn't a hardcoded constant — it's whatever the
	// owner's wizard last successfully registered via POST /api/official-pool, so a real deploy
	// becomes everyone's default view automatically, no code change + redeploy required. `null`
	// means "still checking"; `false` means "checked, nothing registered yet".
	const [officialPool, setOfficialPool] = useState<Address | null | false>(null);
	useEffect(() => {
		if (hasValidHookParam) return;
		let cancelled = false;
		fetch("/api/official-pool")
			.then((res) => res.json())
			.then((data: { hookAddress: Address | null }) => {
				if (!cancelled) setOfficialPool(data.hookAddress ?? false);
			})
			.catch(() => {
				if (!cancelled) setOfficialPool(false);
			});
		return () => {
			cancelled = true;
		};
	}, [hasValidHookParam]);

	// No `?hook=` override and no official pool registered yet means there's genuinely nothing to
	// show — the placeholder branch below renders instead of the dashboard. Every hook call below
	// still runs unconditionally (rules of hooks); `hasPool` just keeps their queries disabled and
	// unused until there's a real address. `stillChecking` avoids flashing the "not deployed"
	// placeholder for the instant it takes the fetch above to resolve.
	const stillChecking = !hasValidHookParam && officialPool === null;
	const officialHookAddress = hasValidHookParam ? (hookParam as Address) : officialPool || null;
	const hasPool = officialHookAddress !== null;
	const hookAddress: Address = officialHookAddress ?? ZERO_ADDRESS;

	const poolKey = useMemo(() => buildDemoPoolKey(hookAddress), [hookAddress]);
	const poolId = useMemo(() => computePoolId(poolKey), [poolKey]);

	const hookContract = { address: hookAddress, abi: hookAbi } as const;

	const { data, isLoading, isError, refetch } = useReadContracts({
		contracts: [
			{ ...hookContract, functionName: "dynamicFee" },
			{ ...hookContract, functionName: "pmmConfig" },
			{ ...hookContract, functionName: "referencePoolPriceWei" },
			{ ...hookContract, functionName: "observationCount" },
			{
				address: addresses.demoMevxExecutor,
				abi: demoMevxExecutorAbi,
				functionName: "authorizedCallers",
				args: [hookAddress],
			},
		],
		query: { enabled: hasPool, refetchInterval: REFRESH_INTERVAL_MS },
	});

	// dynamicFee is uint24 (number). pmmConfig's fields are all uint8..uint32/address/bool (number/
	// string/boolean, never bigint). referencePoolPriceWei is uint256 (bigint). observationCount is
	// uint32 (number). authorizedCallers is bool. See contracts.ts for the full uint8..uint48-vs-
	// uint56+ split this app relies on everywhere it reads on-chain data.
	const dynamicFee = data?.[0]?.result as number | undefined;
	const pmmConfig = data?.[1]?.result as PmmConfigResult | undefined;
	const referencePoolPriceWei = data?.[2]?.result as bigint | undefined;
	const observationCount = data?.[3]?.result as number | undefined;
	// Real capture only executes for a hook this contract has actually authorized — reads the real
	// on-chain set rather than assuming only the showcase pool qualifies (see
	// api/register-reference-pool, which authorizes any pool that completes the wizard's Step 4).
	const captureAvailable = (data?.[4]?.result as boolean | undefined) ?? false;

	// Backstop for the deploy wizard's own auto-registration (see /deploy's "Pool live" panel):
	// that call is 2 sequential on-chain txs and can take 20-30s, so navigating to this page too
	// soon (e.g. clicking "View in dashboard" right away) unmounts /deploy mid-flight and aborts
	// it. Re-runs the same idempotent, walletless server call from here instead, so landing on the
	// dashboard as the owner always self-heals this regardless of timing on the previous page.
	const [refPoolFixStatus, setRefPoolFixStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
	useEffect(() => {
		if (!isOwner || !hasPool || isLoading || captureAvailable || refPoolFixStatus !== "idle") return;
		setRefPoolFixStatus("loading");
		fetch("/api/register-reference-pool", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hookAddress }),
		})
			.then((res) => res.json().then((json) => ({ ok: res.ok, json })))
			.then(({ ok, json }) => {
				setRefPoolFixStatus(ok && !json.error ? "done" : "error");
				if (ok && !json.error) refetch();
			})
			.catch(() => setRefPoolFixStatus("error"));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isOwner, hasPool, isLoading, captureAvailable, hookAddress, refPoolFixStatus]);

	const [, , , , baseFeePips, maxFeePips, feePerDeviationBps, neutralThresholdBps, , , , maxSpotToReferenceDeviationBps, , , pmmEnabled] =
		pmmConfig ?? [];

	// This pool's own two price feeds — NOT a fixed showcase-only address. Every PMM pool (the
	// showcase pool or any wizard-deployed one) owns and configures its own feeds in
	// HomelanderUniV4PluginChainlinkPmm.pmmConfig, so reading them from that struct (rather than a
	// hardcoded constant) is what makes the rest of this dashboard work identically for any of them.
	const token0FeedAddress = pmmConfig?.[0];
	const token1FeedAddress = pmmConfig?.[1];
	const hasFeeds = !!token0FeedAddress && token0FeedAddress !== ZERO_ADDRESS && !!token1FeedAddress && token1FeedAddress !== ZERO_ADDRESS;

	const { data: feedData } = useReadContracts({
		contracts: [
			{ address: token0FeedAddress ?? ZERO_ADDRESS, abi: mockAggregatorAbi, functionName: "latestAnswer" },
			{ address: token1FeedAddress ?? ZERO_ADDRESS, abi: mockAggregatorAbi, functionName: "latestAnswer" },
		],
		query: { enabled: hasFeeds, refetchInterval: REFRESH_INTERVAL_MS },
	});

	// latestAnswer() is Chainlink's native answer, scaled by the feed's own decimals (8 for the
	// MockV3Aggregator feeds every pool here uses) — NOT yet the 18-decimal wei format the
	// contract's own price math uses internally. Scale by 10^(18-8) to match, same conversion as
	// the contract's own `_tryGetUsdPriceWei` (`answer * 10^(18-feedDecimals)`), so downstream $
	// formatting and the pool-implied-price comparison line up correctly.
	const FEED_DECIMALS = 8n;
	const rawToken0Answer = hasFeeds ? (feedData?.[0]?.result as bigint | undefined) : undefined;
	const rawToken1Answer = hasFeeds ? (feedData?.[1]?.result as bigint | undefined) : undefined;
	const token0UsdPriceWei = rawToken0Answer !== undefined ? rawToken0Answer * 10n ** (18n - FEED_DECIMALS) : undefined;
	const token1UsdPriceWei = rawToken1Answer !== undefined ? rawToken1Answer * 10n ** (18n - FEED_DECIMALS) : undefined;

	const wrongNetwork = isConnected && chainId !== sepolia.id;
	const swapDisabled = !isOwner || wrongNetwork;
	const swapDisabledReason = !isOwner
		? "This action is restricted to the project owner's wallet."
		: wrongNetwork
			? "Switch your wallet to Sepolia to swap."
			: undefined;

	// "Run full demo" pushes Pool B, shocks the oracle, then swaps — the swap step needs this pool
	// already authorized to trigger a capture (see refPoolFixStatus above). Gating on that here,
	// rather than letting the click fail with "No reference pool registered", so a fresh deploy
	// just shows a short wait instead of a scary error for the ~20-30s the self-heal above takes.
	const captureDemoDisabled = swapDisabled || (!captureAvailable && !isLoading);
	const captureDemoDisabledReason =
		swapDisabledReason ??
		(!captureAvailable && !isLoading
			? refPoolFixStatus === "error"
				? "Couldn't enable the MEV-capture demo automatically — reload this page to retry."
				: "Setting up the MEV-capture demo for this pool — usually ready within 30 seconds of a fresh deploy."
			: undefined);

	if (stillChecking) {
		return <div className="max-w-5xl mx-auto px-6 py-10" />;
	}

	if (!hasPool) {
		return (
			<div className="max-w-5xl mx-auto px-6 py-10">
				<div className="glass-panel p-8 flex flex-col items-start gap-3">
					<p className="label-caps">Showcase pool</p>
					<p className="text-lg text-white">No pool deployed yet.</p>
					<p className="text-sm text-neutral-400">
						The project owner hasn&apos;t deployed the showcase pool through{" "}
						<Link href="/deploy" className="underline hover:text-neutral-200">
							the wizard
						</Link>{" "}
						yet — check back soon.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="max-w-5xl mx-auto px-6 py-10 space-y-6">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<HookAddressHeader hookAddress={hookAddress} isDefault={!hasValidHookParam} />
				<Link href="/mainnet" className="text-sm text-neutral-400 hover:text-neutral-200">
					Real mainnet activity →
				</Link>
			</div>

			{!isOwner && (
				<div className="glass-panel px-4 py-3 text-sm text-neutral-400">
					This is a read-only view of the live showcase pool — every number below is real and live, but
					only the project owner&apos;s wallet can swap, push updates, or trigger a capture.
				</div>
			)}
			{isOwner && wrongNetwork && (
				<div className="glass-panel border-amber-400/30 bg-amber-500/[0.04] px-4 py-3 text-sm text-amber-300">
					Your wallet is on the wrong network — switch to Sepolia to interact with this pool.
				</div>
			)}

			<MevStatsPanel poolId={poolId} />

			<HookStatsPanel
				isLoading={isLoading}
				isError={isError}
				pmmEnabled={pmmEnabled}
				baseFeePips={pmmEnabled ? baseFeePips : (defaultFeePipsFrom(dynamicFee) ?? undefined)}
				maxFeePips={maxFeePips}
				feePerDeviationBps={feePerDeviationBps}
				neutralThresholdBps={neutralThresholdBps}
				maxSpotToReferenceDeviationBps={maxSpotToReferenceDeviationBps}
				token0UsdPriceWei={token0UsdPriceWei}
				token1UsdPriceWei={token1UsdPriceWei}
				referencePoolPriceWei={referencePoolPriceWei}
				observationCount={observationCount}
				dynamicFee={dynamicFee}
			/>

			{isOwner && hasFeeds && token1FeedAddress && (
				<OneClickDemoButton
					poolKey={poolKey}
					poolId={poolId}
					priceFeedAddress={token1FeedAddress}
					disabled={captureDemoDisabled}
					disabledReason={captureDemoDisabledReason}
					onDone={() => refetch()}
				/>
			)}

			{isOwner && hasFeeds && token1FeedAddress && (
				<PriceShockControls priceFeedAddress={token1FeedAddress} disabled={swapDisabled} onConfirmed={() => refetch()} />
			)}

			{isOwner && (
				<SwapWidget
					poolKey={poolKey}
					disabled={swapDisabled}
					disabledReason={swapDisabledReason}
					onSwapConfirmed={() => refetch()}
				/>
			)}

			<ArbSpreadPanel
				poolId={poolId}
				disabled={swapDisabled}
				disabledReason={swapDisabledReason}
				captureAvailable={captureAvailable}
				isOwner={isOwner}
			/>

			<FeeHistory poolId={poolId} />
		</div>
	);
}
