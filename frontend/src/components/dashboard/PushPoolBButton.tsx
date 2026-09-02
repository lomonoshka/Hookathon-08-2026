"use client";

import { useEffect, useState } from "react";
import { maxUint256, parseUnits, type Hex } from "viem";
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { addresses, erc20Abi, poolSwapTestAbi } from "@/lib/contracts";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, type PoolKeyStruct } from "@/lib/poolKey";
import { getFreshNonce } from "@/lib/nonce";

const SWAP_TEST_SETTINGS = { takeClaims: false, settleUsingBurn: false } as const;

// Fixed, modest, hardcoded "nudge" — this is a one-click demo action, not a full swap form (see
// SwapWidget.tsx for the full amount-input flow used on the protected pool above). Direction is
// currency1 -> currency0; the exact size doesn't matter, it just needs to be enough to move Pool
// B's price away from Pool A's.
const PUSH_ZERO_FOR_ONE = false;
const PUSH_AMOUNT_STR = "0.005";

/**
 * Swaps directly in the reference pool ("Pool B") via the same PoolSwapTest test-router
 * SwapWidget.tsx uses for the protected pool, to deliberately create a price gap the hook's
 * arbitrage mechanism can then capture. Handles approve-then-swap for whichever token this
 * fixed direction pays in.
 */
export function PushPoolBButton({
	poolBKey,
	disabled,
	disabledReason,
}: {
	poolBKey: PoolKeyStruct;
	disabled?: boolean;
	disabledReason?: string;
}) {
	const { address: account } = useAccount();
	const tokenIn = PUSH_ZERO_FOR_ONE ? poolBKey.currency0 : poolBKey.currency1;

	// Token metadata for whichever side of Pool B this fixed direction pays in.
	const { data: metaData } = useReadContracts({
		contracts: [
			{ address: tokenIn, abi: erc20Abi, functionName: "symbol" },
			{ address: tokenIn, abi: erc20Abi, functionName: "decimals" },
		],
	});
	const symIn = metaData?.[0]?.result as string | undefined;
	// decimals() returns uint8 — viem decodes it as a plain number (see SwapWidget.tsx for the
	// same read and the full number/bigint split this app relies on).
	const decIn = (metaData?.[1]?.result as number | undefined) ?? 18;

	const { data: allowanceData, refetch: refetchAllowance } = useReadContracts({
		contracts: account
			? [{ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [account, addresses.poolSwapTest] }]
			: [],
		query: { enabled: !!account, refetchInterval: 8000 },
	});
	const allowance = allowanceData?.[0]?.result as bigint | undefined;

	const amountWei = parseUnits(PUSH_AMOUNT_STR, decIn);
	const needsApproval = allowance === undefined || allowance < amountWei;

	// ── Approve ──
	const { writeContractAsync: approveAsync, isPending: isApprovePending, error: approveError, reset: resetApprove } =
		useWriteContract();
	const [approveHash, setApproveHash] = useState<Hex | undefined>();
	const { isLoading: isApproveConfirming, isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({
		hash: approveHash,
	});

	useEffect(() => {
		if (isApproveConfirmed) refetchAllowance();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isApproveConfirmed]);

	async function handleApprove() {
		resetApprove();
		setApproveHash(undefined);
		if (!account) return;
		try {
			const hash = await approveAsync({
				address: tokenIn,
				abi: erc20Abi,
				functionName: "approve",
				args: [addresses.poolSwapTest, maxUint256],
				nonce: await getFreshNonce(account),
			});
			setApproveHash(hash);
		} catch {
			// surfaced via approveError below
		}
	}

	// ── Push (swap) ──
	const { writeContractAsync: swapAsync, isPending: isSwapPending, error: swapError, reset: resetSwap } =
		useWriteContract();
	const [swapHash, setSwapHash] = useState<Hex | undefined>();
	const { isLoading: isSwapConfirming, isSuccess: isSwapConfirmed } = useWaitForTransactionReceipt({
		hash: swapHash,
	});

	useEffect(() => {
		if (isSwapConfirmed) refetchAllowance();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isSwapConfirmed]);

	async function handlePush() {
		resetSwap();
		setSwapHash(undefined);
		if (!account) return;
		try {
			const hash = await swapAsync({
				address: addresses.poolSwapTest,
				abi: poolSwapTestAbi,
				functionName: "swap",
				args: [
					poolBKey,
					{
						zeroForOne: PUSH_ZERO_FOR_ONE,
						amountSpecified: -amountWei, // negative == exact input
						sqrtPriceLimitX96: PUSH_ZERO_FOR_ONE ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
					},
					SWAP_TEST_SETTINGS,
					"0x",
				],
				gas: 2_000_000n,
				nonce: await getFreshNonce(account),
			});
			setSwapHash(hash);
		} catch {
			// surfaced via swapError below
		}
	}

	const busy = isApprovePending || isApproveConfirming || isSwapPending || isSwapConfirming;
	const allDisabled = disabled || busy;

	return (
		<div className="border-t border-white/10 pt-4 space-y-2">
			<p className="text-xs text-neutral-500">
				Swaps directly in the reference pool (not the protected one) to create a price gap — then do a
				normal swap in the protected pool above to see it get captured.
			</p>
			{disabledReason && <p className="text-xs text-amber-300">{disabledReason}</p>}

			<div className="flex flex-wrap items-center gap-3">
				{needsApproval ? (
					<button
						type="button"
						onClick={handleApprove}
						disabled={allDisabled}
						className="text-sm px-4 py-2 rounded-lg bg-neutral-100 text-neutral-900 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
					>
						{isApprovePending ? "Confirm in wallet…" : isApproveConfirming ? "Approving…" : `Approve ${symIn ?? "token"}`}
					</button>
				) : (
					<button
						type="button"
						onClick={handlePush}
						disabled={allDisabled}
						className="text-sm px-4 py-2 rounded-lg bg-amber-500/20 border border-amber-500/50 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
					>
						{isSwapPending
							? "Confirm in wallet…"
							: isSwapConfirming
								? "Pushing…"
								: `Push Pool B (${PUSH_AMOUNT_STR} ${symIn ?? ""})`}
					</button>
				)}
			</div>

			{approveError && <p className="text-xs text-red-400 break-all">{approveError.message}</p>}
			{swapError && <p className="text-xs text-red-400 break-all">{swapError.message}</p>}
			{isSwapConfirmed && !swapError && (
				<p className="text-xs text-emerald-400">Pool B nudged — check the spread above.</p>
			)}
		</div>
	);
}
