"use client";

import { useEffect, useState } from "react";
import { formatUnits, maxUint256, parseUnits, type Hex } from "viem";
import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { addresses, erc20Abi, poolSwapTestAbi } from "@/lib/contracts";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, type PoolKeyStruct } from "@/lib/poolKey";
import { getFreshNonce } from "@/lib/nonce";

const SWAP_TEST_SETTINGS = { takeClaims: false, settleUsingBurn: false } as const;

/** Parses a user-typed amount string into base units, tolerating empty/invalid input (rather
 * than throwing on every keystroke) by falling back to 0n. */
function safeParseUnits(value: string, decimals: number): bigint {
	if (!value || Number(value) <= 0) return 0n;
	try {
		return parseUnits(value, decimals);
	} catch {
		return 0n;
	}
}

export function SwapWidget({
	poolKey,
	disabled,
	disabledReason,
	onSwapConfirmed,
}: {
	poolKey: PoolKeyStruct;
	disabled?: boolean;
	disabledReason?: string;
	onSwapConfirmed?: () => void;
}) {
	const { address: account } = useAccount();
	const [zeroForOne, setZeroForOne] = useState(true);
	const [amount, setAmount] = useState("0.001");

	// Token metadata (symbol/decimals) never changes — a single always-on batched read.
	const { data: metaData } = useReadContracts({
		contracts: [
			{ address: poolKey.currency0, abi: erc20Abi, functionName: "symbol" },
			{ address: poolKey.currency0, abi: erc20Abi, functionName: "decimals" },
			{ address: poolKey.currency1, abi: erc20Abi, functionName: "symbol" },
			{ address: poolKey.currency1, abi: erc20Abi, functionName: "decimals" },
		],
	});
	const sym0 = metaData?.[0]?.result as string | undefined;
	// decimals() returns uint8 — viem decodes it as a plain number (see DashboardContent for the
	// full uint8..uint48-vs-uint56+ number/bigint split that actually matters here).
	const dec0 = (metaData?.[1]?.result as number | undefined) ?? 18;
	const sym1 = metaData?.[2]?.result as string | undefined;
	const dec1 = (metaData?.[3]?.result as number | undefined) ?? 18;

	// Balance + allowance for both tokens — only meaningful once a wallet is connected.
	const { data: balData, refetch: refetchBalances } = useReadContracts({
		contracts: account
			? [
					{ address: poolKey.currency0, abi: erc20Abi, functionName: "balanceOf", args: [account] },
					{ address: poolKey.currency1, abi: erc20Abi, functionName: "balanceOf", args: [account] },
					{
						address: poolKey.currency0,
						abi: erc20Abi,
						functionName: "allowance",
						args: [account, addresses.poolSwapTest],
					},
					{
						address: poolKey.currency1,
						abi: erc20Abi,
						functionName: "allowance",
						args: [account, addresses.poolSwapTest],
					},
				]
			: [],
		query: { enabled: !!account, refetchInterval: 8000 },
	});
	const bal0 = balData?.[0]?.result as bigint | undefined;
	const bal1 = balData?.[1]?.result as bigint | undefined;
	const allow0 = balData?.[2]?.result as bigint | undefined;
	const allow1 = balData?.[3]?.result as bigint | undefined;

	const tokenIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
	const symIn = zeroForOne ? (sym0 ?? "token0") : (sym1 ?? "token1");
	const symOut = zeroForOne ? (sym1 ?? "token1") : (sym0 ?? "token0");
	const decIn = zeroForOne ? dec0 : dec1;
	const balanceIn = zeroForOne ? bal0 : bal1;
	const allowanceIn = zeroForOne ? allow0 : allow1;

	const amountWei = safeParseUnits(amount, decIn);

	const needsApproval = amountWei > 0n && (allowanceIn === undefined || allowanceIn < amountWei);

	// ── Approve ──
	const { writeContractAsync: approveAsync, isPending: isApprovePending, error: approveError, reset: resetApprove } =
		useWriteContract();
	const [approveHash, setApproveHash] = useState<Hex | undefined>();
	const { isLoading: isApproveConfirming, isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({
		hash: approveHash,
	});

	useEffect(() => {
		if (isApproveConfirmed) refetchBalances();
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

	// ── Swap ──
	const { writeContractAsync: swapAsync, isPending: isSwapPending, error: swapError, reset: resetSwap } =
		useWriteContract();
	const [swapHash, setSwapHash] = useState<Hex | undefined>();
	const { isLoading: isSwapConfirming, isSuccess: isSwapConfirmed } = useWaitForTransactionReceipt({
		hash: swapHash,
	});

	useEffect(() => {
		if (isSwapConfirmed) {
			refetchBalances();
			onSwapConfirmed?.();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isSwapConfirmed]);

	async function handleSwap() {
		resetSwap();
		setSwapHash(undefined);
		if (!account) return;
		try {
			const hash = await swapAsync({
				address: addresses.poolSwapTest,
				abi: poolSwapTestAbi,
				functionName: "swap",
				args: [
					poolKey,
					{
						zeroForOne,
						amountSpecified: -amountWei, // negative == exact input (matches the contract test suite)
						sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
					},
					SWAP_TEST_SETTINGS,
					"0x",
				],
				// A swap through the hook forwards up to callGasBudget (5M by default) into a
				// nested arb-check call inside _afterSwap — give explicit headroom rather than
				// relying on estimation, same reasoning as the deploy wizard's transactions.
				gas: 7_000_000n,
				nonce: await getFreshNonce(account),
			});
			setSwapHash(hash);
		} catch {
			// surfaced via swapError below
		}
	}

	const busy = isApprovePending || isApproveConfirming || isSwapPending || isSwapConfirming;
	const allDisabled = disabled || busy;
	const swapButtonDisabled = allDisabled || amountWei <= 0n || needsApproval;
	const approveButtonDisabled = allDisabled || amountWei <= 0n;

	return (
		<section className="glass-panel p-5 space-y-4">
			<h2 className="label-caps">Swap through this pool</h2>
			{disabledReason && <p className="text-xs text-amber-300">{disabledReason}</p>}

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setZeroForOne((v) => !v)}
					disabled={allDisabled}
					className="text-sm px-3 py-2 rounded-lg border border-white/15 hover:border-white/35 text-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				>
					{symIn} → {symOut}
				</button>
				<span className="text-xs text-neutral-500">click to flip direction</span>
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs text-neutral-500">Amount ({symIn})</span>
					<input
						type="number"
						min="0"
						step="any"
						value={amount}
						onChange={(e) => setAmount(e.target.value)}
						disabled={allDisabled}
						className="w-40 bg-white/[0.04] border border-white/15 rounded-lg px-3 py-2 text-sm text-neutral-100 disabled:opacity-40"
					/>
				</label>
				<span className="text-xs text-neutral-500 pb-2">
					Balance: {balanceIn !== undefined ? Number(formatUnits(balanceIn, decIn)).toFixed(4) : "—"} {symIn}
				</span>
			</div>

			<div className="flex flex-wrap gap-3">
				{needsApproval && (
					<button
						type="button"
						onClick={handleApprove}
						disabled={approveButtonDisabled}
						className="text-sm px-4 py-2 rounded-lg bg-neutral-100 text-neutral-900 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
					>
						{isApprovePending ? "Confirm in wallet…" : isApproveConfirming ? "Approving…" : `Approve ${symIn}`}
					</button>
				)}
				<button
					type="button"
					onClick={handleSwap}
					disabled={swapButtonDisabled}
					className="text-sm px-4 py-2 rounded-lg bg-sky-500 text-neutral-950 font-medium hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				>
					{isSwapPending ? "Confirm in wallet…" : isSwapConfirming ? "Swapping…" : "Swap"}
				</button>
			</div>

			{approveError && <p className="text-xs text-red-400 break-all">{approveError.message}</p>}
			{swapError && <p className="text-xs text-red-400 break-all">{swapError.message}</p>}
			{isSwapConfirmed && !swapError && <p className="text-xs text-emerald-400">Swap confirmed.</p>}
		</section>
	);
}
