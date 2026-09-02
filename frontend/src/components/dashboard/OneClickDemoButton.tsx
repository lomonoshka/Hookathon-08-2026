"use client";

import { useState } from "react";
import { maxUint256, parseUnits, type Address, type Hex } from "viem";
import { useAccount, useWriteContract } from "wagmi";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { addresses, demoMevxRouterAbi, erc20Abi, mockAggregatorAbi, poolSwapTestAbi } from "@/lib/contracts";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, type PoolKeyStruct } from "@/lib/poolKey";
import { getFreshNonce } from "@/lib/nonce";

// Same fixed amounts already proven to work end-to-end in scripts/deploySepoliaPmm.ts's own
// smoke test and in PushPoolBButton.tsx — reused here rather than re-derived, so this button
// can't drift out of sync with what's actually been tested against this pool's thin liquidity.
const PUSH_POOL_B_AMOUNT = parseUnits("0.005", 18); // WETH
const DEMO_SWAP_AMOUNT = parseUnits("0.001", 6); // USDC — buying WETH, the penalty direction after a shock

type Step = "idle" | "push-b" | "shock" | "swap" | "done" | "error";

const STEP_LABEL: Record<Exclude<Step, "idle" | "done" | "error">, string> = {
	"push-b": "Pushing Pool B…",
	shock: "Shocking the oracle…",
	swap: "Swapping (buying WETH)…",
};

/**
 * One button that chains everything needed to demonstrate both mechanics from a single click:
 * push Pool B (arbitrage-spread setup), shock the oracle (dynamic-fee setup), then one swap that
 * pays an elevated fee AND triggers a capture in the same transaction — both are consequences of
 * the same `_afterSwap` call. Still several separate on-chain transactions (each touches a
 * different contract/permission boundary — Pool B's own liquidity, the mock feed, the protected
 * pool), so still several MetaMask confirmations, but the sequencing/waiting is automatic.
 */
export function OneClickDemoButton({
	poolKey,
	poolId,
	priceFeedAddress,
	disabled,
	disabledReason,
	onDone,
}: {
	poolKey: PoolKeyStruct;
	poolId: Hex;
	priceFeedAddress: Address;
	disabled?: boolean;
	disabledReason?: string;
	onDone?: () => void;
}) {
	const { address: account } = useAccount();
	const { writeContractAsync } = useWriteContract();
	const [step, setStep] = useState<Step>("idle");
	const [error, setError] = useState<string | null>(null);

	async function ensureApproval(token: Address, spender: Address, amount: bigint) {
		if (!account) throw new Error("Wallet not connected.");
		const allowance = await readContract(wagmiConfig, {
			address: token,
			abi: erc20Abi,
			functionName: "allowance",
			args: [account, spender],
		});
		if (allowance >= amount) return;
		const hash = await writeContractAsync({
			address: token,
			abi: erc20Abi,
			functionName: "approve",
			args: [spender, maxUint256],
			nonce: await getFreshNonce(account),
		});
		await waitForTransactionReceipt(wagmiConfig, { hash });
	}

	async function run() {
		setError(null);
		if (!account) {
			setError("Wallet not connected.");
			setStep("error");
			return;
		}
		try {
			// ── 1. Push Pool B — creates the Pool A/B spread the arbitrage check reacts to ──
			setStep("push-b");
			const hasRef = await readContract(wagmiConfig, {
				address: addresses.demoMevxRouter,
				abi: demoMevxRouterAbi,
				functionName: "hasReferencePool",
				args: [poolId],
			});
			if (!hasRef) {
				throw new Error("No reference pool (Pool B) registered for this pool yet.");
			}
			const [refCurrency0, refCurrency1, refFee, refTickSpacing, refHooks] = await readContract(wagmiConfig, {
				address: addresses.demoMevxRouter,
				abi: demoMevxRouterAbi,
				functionName: "referencePool",
				args: [poolId],
			});
			const poolBKey: PoolKeyStruct = {
				currency0: refCurrency0,
				currency1: refCurrency1,
				fee: refFee,
				tickSpacing: refTickSpacing,
				hooks: refHooks,
			};
			// PushPoolBButton's fixed direction: give currency1 (WETH), receive currency0. Pool B's
			// liquidity is thin and shared across every pool this whole demo has ever pushed, so a
			// single fixed-size nudge isn't reliably enough to clear minSpreadBps any more (confirmed:
			// one push here recently only moved the spread to ~0.89% against a 3% threshold, so the
			// capture step below silently never fired even though the swap itself worked fine) — keep
			// pushing and re-checking the real on-chain spread until it's actually capturable, instead
			// of assuming one push is enough.
			const MAX_PUSH_ATTEMPTS = 5;
			let arbCheck = await readContract(wagmiConfig, {
				address: addresses.demoMevxRouter,
				abi: demoMevxRouterAbi,
				functionName: "initialArbCheck",
				args: [poolId, true],
			});
			let pushAttempts = 0;
			while (!arbCheck[0] && pushAttempts < MAX_PUSH_ATTEMPTS) {
				await ensureApproval(poolBKey.currency1, addresses.poolSwapTest, PUSH_POOL_B_AMOUNT);
				const pushHash = await writeContractAsync({
					address: addresses.poolSwapTest,
					abi: poolSwapTestAbi,
					functionName: "swap",
					args: [
						poolBKey,
						{ zeroForOne: false, amountSpecified: -PUSH_POOL_B_AMOUNT, sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n },
						{ takeClaims: false, settleUsingBurn: false },
						"0x",
					],
					gas: 2_000_000n,
					nonce: await getFreshNonce(account),
				});
				await waitForTransactionReceipt(wagmiConfig, { hash: pushHash });
				pushAttempts++;
				arbCheck = await readContract(wagmiConfig, {
					address: addresses.demoMevxRouter,
					abi: demoMevxRouterAbi,
					functionName: "initialArbCheck",
					args: [poolId, true],
				});
			}
			if (!arbCheck[0]) {
				throw new Error(`Spread still below threshold after ${pushAttempts} pushes to Pool B — try again in a moment.`);
			}

			// ── 2. Shock the oracle — creates the deviation the dynamic fee reacts to ──
			setStep("shock");
			const currentAnswer = await readContract(wagmiConfig, {
				address: priceFeedAddress,
				abi: mockAggregatorAbi,
				functionName: "latestAnswer",
			});
			const shockedAnswer = (currentAnswer * 110n) / 100n;
			const shockHash = await writeContractAsync({
				address: priceFeedAddress,
				abi: mockAggregatorAbi,
				functionName: "updateAnswer",
				args: [shockedAnswer],
				nonce: await getFreshNonce(account),
			});
			await waitForTransactionReceipt(wagmiConfig, { hash: shockHash });

			// ── 3. One swap in the protected pool — pays the elevated fee AND triggers the capture ──
			setStep("swap");
			// This app's pool is always WETH/USDC sorted currency0=USDC/currency1=WETH (see
			// buildDemoPoolKey) — zeroForOne=true spends currency0 (USDC), buying currency1 (WETH),
			// the same "informed buy" direction proven in scripts/deploySepoliaPmm.ts's own smoke
			// test to land in the PMM's penalty branch after an oracle shock.
			await ensureApproval(poolKey.currency0, addresses.poolSwapTest, DEMO_SWAP_AMOUNT);
			const swapHash = await writeContractAsync({
				address: addresses.poolSwapTest,
				abi: poolSwapTestAbi,
				functionName: "swap",
				args: [
					poolKey,
					{
						zeroForOne: true,
						amountSpecified: -DEMO_SWAP_AMOUNT,
						sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n,
					},
					{ takeClaims: false, settleUsingBurn: false },
					"0x",
				],
				gas: 7_000_000n,
				nonce: await getFreshNonce(account),
			});
			await waitForTransactionReceipt(wagmiConfig, { hash: swapHash });

			setStep("done");
			onDone?.();
		} catch (err) {
			setError((err as Error).message);
			setStep("error");
		}
	}

	const busy = step !== "idle" && step !== "done" && step !== "error";

	return (
		<section className="glass-panel border-sky-400/30 bg-sky-500/[0.04] p-5 space-y-3">
			<h2 className="label-caps text-sky-300">Run full demo (one click)</h2>
			<p className="text-xs text-neutral-400">
				Pushes Pool B, shocks the oracle, then does one swap that pays an elevated fee and triggers a real
				capture — both effects of the same transaction.
			</p>
			{disabledReason && <p className="text-xs text-amber-300">{disabledReason}</p>}
			<button
				type="button"
				onClick={run}
				disabled={disabled || busy}
				className="text-sm px-4 py-2 rounded-lg bg-sky-500 text-neutral-950 font-medium hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
			>
				{step === "idle" && "Run full demo"}
				{busy && STEP_LABEL[step as Exclude<Step, "idle" | "done" | "error">]}
				{step === "done" && "Done — run again"}
				{step === "error" && "Retry"}
			</button>
			{step === "done" && (
				<p className="text-xs text-emerald-400">
					Done — check &quot;Recent applied fees&quot; and &quot;MEV captured by this hook&quot; above.
				</p>
			)}
			{error && <p className="text-xs text-red-400 break-all">{error}</p>}
		</section>
	);
}
