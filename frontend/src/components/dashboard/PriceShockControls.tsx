"use client";

import { useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { mockAggregatorAbi } from "@/lib/contracts";
import { getFreshNonce } from "@/lib/nonce";

/**
 * Live control for the showcase pool's mock Chainlink feed: pushes a new `updateAnswer` so the
 * fee-tier panel above reacts in real time. Only meaningfully callable by whoever owns
 * `demoMockPriceFeed` — we deliberately don't gate the UI on ownership (not worth wiring up an
 * `owner()` read for a hackathon demo); an unauthorized wallet just sees the tx fail, which is
 * an acceptable failure mode here.
 */
export function PriceShockControls({
	priceFeedAddress,
	disabled,
	onConfirmed,
}: {
	priceFeedAddress: Address;
	disabled?: boolean;
	onConfirmed?: () => void;
}) {
	const { address: account } = useAccount();
	const {
		data: latestAnswer,
		refetch: refetchAnswer,
	} = useReadContract({
		address: priceFeedAddress,
		abi: mockAggregatorAbi,
		functionName: "latestAnswer",
		query: { refetchInterval: 6000 },
	});

	// Remember the first price we ever observed as the "calm" baseline to reset back to.
	const baselineRef = useRef<bigint | null>(null);
	useEffect(() => {
		if (baselineRef.current === null && typeof latestAnswer === "bigint") {
			baselineRef.current = latestAnswer;
		}
	}, [latestAnswer]);

	const { writeContractAsync, isPending, error, reset } = useWriteContract();
	const [hash, setHash] = useState<Hex | undefined>();
	const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

	useEffect(() => {
		if (isSuccess) {
			refetchAnswer();
			onConfirmed?.();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isSuccess]);

	async function push(newAnswer: bigint) {
		reset();
		setHash(undefined);
		if (!account) return;
		try {
			const txHash = await writeContractAsync({
				address: priceFeedAddress,
				abi: mockAggregatorAbi,
				functionName: "updateAnswer",
				args: [newAnswer],
				nonce: await getFreshNonce(account),
			});
			setHash(txHash);
		} catch {
			// surfaced via `error` below
		}
	}

	function shock() {
		const current = latestAnswer ?? baselineRef.current ?? 0n;
		push((current * 110n) / 100n);
	}

	function calm() {
		const target = baselineRef.current ?? latestAnswer ?? 0n;
		push(target);
	}

	const busy = isPending || isConfirming;
	const buttonsDisabled = disabled || busy || latestAnswer === undefined;

	return (
		<section className="glass-panel p-5 space-y-3">
			<h2 className="label-caps">Demo price feed control</h2>
			<p className="text-xs text-neutral-500">
				Pushes a new answer straight to this pool&apos;s mock Chainlink feed (
				<span className="font-mono">
					{priceFeedAddress.slice(0, 6)}…{priceFeedAddress.slice(-4)}
				</span>
				) so you can watch the fee tier react live. Only the deployer wallet can actually push an
				update — any other connected wallet will just see the transaction fail.
			</p>
			<div className="flex flex-wrap gap-3">
				<button
					type="button"
					onClick={shock}
					disabled={buttonsDisabled}
					className="text-sm px-3 py-2 rounded bg-red-500/10 border border-red-500/40 text-red-300 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				>
					Simulate +10% price shock
				</button>
				<button
					type="button"
					onClick={calm}
					disabled={buttonsDisabled}
					className="text-sm px-3 py-2 rounded bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
				>
					Reset to calm
				</button>
			</div>
			{busy && (
				<p className="text-xs text-neutral-500">
					{isPending ? "Confirm in wallet…" : "Waiting for confirmation…"}
				</p>
			)}
			{error && <p className="text-xs text-red-400 break-all">{error.message}</p>}
		</section>
	);
}
