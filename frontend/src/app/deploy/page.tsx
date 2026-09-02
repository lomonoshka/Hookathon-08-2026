"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	keccak256,
	maxUint256,
	zeroHash,
	type Address,
	type Hex,
} from "viem";
import { sepolia } from "wagmi/chains";
import { useAccount, useChainId, useSendTransaction, useSwitchChain } from "wagmi";
import { getTransactionReceipt, readContract, waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi";
import { addresses, demoMevxRouterAbi, erc20Abi } from "@/lib/contracts";
import { useIsOwner } from "@/lib/useIsOwner";
import { getFreshNonce } from "@/lib/nonce";
import { hookAbi as hookFullAbi, hookCreationBytecode } from "@/lib/hookArtifact";
import { mockAggregatorCreationBytecode } from "@/lib/mockAggregatorArtifact";
import { DeployHistoryPanel } from "@/components/dashboard/DeployHistoryPanel";
import { poolManagerAbi } from "./poolManagerAbi";
import { poolModifyLiquidityTestAbi } from "./poolModifyLiquidityTestAbi";

// ──────────────────── Fixed, hackathon-scope config ────────────────────

// Short, curated token list — avoids an arbitrary-token-address input (scam-token risk, extra
// validation) for v1. Add more pairs here if the demo ever needs them.
const TOKENS = [
	{ symbol: "WETH", address: addresses.weth },
	{ symbol: "USDC", address: addresses.usdc },
] as const satisfies readonly { symbol: string; address: Address }[];

// LPFeeLibrary.DYNAMIC_FEE_FLAG — highest bit of the uint24 fee field.
const DYNAMIC_FEE_FLAG = 0x800000;
// Baseline LP fee, both for the hook's own dynamicFee_ constructor arg (defaultFeePips/baseFee)
// and PMM's baseFee config — matches the showcase pool's own values (scripts/deploySepoliaPmm.ts).
const DEFAULT_FEE_PIPS = 3000; // 0.30%
const CONSTRUCTOR_DYNAMIC_FEE = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;

// Required on the PoolKey itself so the hook's dynamic-fee override can take effect at swap time
// (independent of whether the hook's own `dynamicFee_` happened to be 0).
const POOL_KEY_FEE = DYNAMIC_FEE_FLAG;
const TICK_SPACING = 60;

// sqrtPriceX96 for ~2500 USDC/WETH — NOT a naive 1:1 raw-unit price. USDC (6 decimals) and WETH
// (18 decimals) are 12 decimals apart, so a literal 1:1 raw price implies WETH is worth ~1e-12
// USDC — and every PMM fee calc compares this bootstrap price against a *realistic* USD oracle
// value, so a mismatched bootstrap reads as a huge (and permanent) "deviation" before a single
// real trade happens, pinning the fee at maxFee from block one. Same fix already applied in
// scripts/deploySepoliaPmm.ts after hitting exactly this bug on the showcase pool.
const SQRT_PRICE_USDC_WETH = 20000n * 2n ** 96n;

// Tick implied by SQRT_PRICE_USDC_WETH (Math.floor(Math.log(4e8) / Math.log(1.0001))) — fixed
// because the bootstrap price above is fixed. A ±20-tick-spacing band around it (same range
// proven against the showcase pool in scripts/resetShowcasePmm2.ts) is enough concentrated
// liquidity for the demo's small swap amounts without spreading it too thin.
const CURRENT_TICK_APPROX = 198079;
const LIQUIDITY_CENTER_TICK = Math.floor(CURRENT_TICK_APPROX / TICK_SPACING) * TICK_SPACING;
const LIQUIDITY_TICK_LOWER = LIQUIDITY_CENTER_TICK - 20 * TICK_SPACING;
const LIQUIDITY_TICK_UPPER = LIQUIDITY_CENTER_TICK + 20 * TICK_SPACING;
const LIQUIDITY_DELTA = 2_000_000_000_000n;

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
// Constants.UNISWAP_V4_POOL_TYPE, from contracts/Constants.sol.
const UNISWAP_V4_POOL_TYPE = 5;

// PMM config defaults — identical to the showcase pool's (scripts/deploySepoliaPmm.ts), including
// a 30-day maxOracleAge: the showcase pool originally shipped with 1 hour, and once real wall-clock
// time passed the "USDC/USD" feed (which nothing but "Simulate shock" ever pushes — and that only
// touches the WETH feed) went stale, silently flooring every fee back to baseFee. Applying the fix
// from deploy time here avoids every future pool re-discovering the same bug an hour in.
const MAX_FEE_PIPS = 10_000; // 1.00%
const FEE_PER_DEVIATION_BPS = 10;
const NEUTRAL_THRESHOLD_BPS = 5;
const MAX_ORACLE_AGE = 30 * 24 * 3600; // 30 days
const OBSERVATION_WINDOW = 60;
const MIN_OBSERVATION_AGE = 1;
const MAX_SPOT_TO_REFERENCE_DEVIATION_BPS = 50;
const MAX_LIMIT_TO_SPOT_DEVIATION_BPS = 500;
// Initial oracle answers (Chainlink 8-decimal format) — must match the pool's own bootstrap price
// above (USDC $1.00, WETH $2500.00) for the same reason the bootstrap price itself was fixed.
const INITIAL_USDC_ANSWER = 1_00000000n;
const INITIAL_WETH_ANSWER = 2500_00000000n;

const POOL_KEY_ENCODING = [
	{ type: "address" },
	{ type: "address" },
	{ type: "uint24" },
	{ type: "int24" },
	{ type: "address" },
] as const;

type PoolKeyStruct = {
	currency0: Address;
	currency1: Address;
	fee: number;
	tickSpacing: number;
	hooks: Address;
};

type Phase =
	| "form"
	| "mining"
	| "awaiting-hook-signature"
	| "confirming-hook"
	| "hook-confirmed"
	| "configuring-pmm"
	| "pmm-configured"
	| "awaiting-init-signature"
	| "confirming-init"
	| "success";

type PmmSubStep = "feed0" | "feed1" | "config" | null;

function sortCurrencies(a: Address, b: Address): [Address, Address] {
	return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

function computePoolId(key: PoolKeyStruct): Hex {
	// Matches PoolIdLibrary.toId(): keccak256(abi.encode(key)) — abi.encode of the PoolKey struct
	// is the same as ABI-encoding its 5 fields in order, each padded to a 32-byte word.
	return keccak256(
		encodeAbiParameters(POOL_KEY_ENCODING, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks])
	);
}

function errorMessage(err: unknown): string {
	if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
		return err.shortMessage;
	}
	if (err instanceof Error) return err.message;
	return "Something went wrong.";
}

const etherscanTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
const etherscanAddress = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;

// Persists deploy progress per-wallet so a page refresh (or a wallet reconnect, which used to
// force one) resumes instead of silently offering to deploy a second hook on top of one that's
// already live.
const STORAGE_KEY_PREFIX = "homelander-deploy-progress:";

interface SavedProgress {
	phase: Phase;
	hookAddress: Address | null;
	hookTxHash: Hex | null;
	token0FeedAddress: Address | null;
	token1FeedAddress: Address | null;
	pmmConfigTxHash: Hex | null;
	poolId: Hex | null;
	initTxHash: Hex | null;
	token0Symbol: string;
	token1Symbol: string;
}

function loadProgress(address: Address): SavedProgress | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY_PREFIX + address.toLowerCase());
		return raw ? (JSON.parse(raw) as SavedProgress) : null;
	} catch {
		return null;
	}
}

function saveProgress(address: Address, progress: SavedProgress) {
	try {
		localStorage.setItem(STORAGE_KEY_PREFIX + address.toLowerCase(), JSON.stringify(progress));
	} catch {
		// ignore quota/availability errors — worst case, resume just doesn't work this session
	}
}

function clearProgress(address: Address) {
	try {
		localStorage.removeItem(STORAGE_KEY_PREFIX + address.toLowerCase());
	} catch {
		// ignore
	}
}

export default function DeployPage() {
	const { address, isConnected } = useAccount();
	const isOwner = useIsOwner();
	const chainId = useChainId();
	const { switchChain, isPending: isSwitching } = useSwitchChain();
	const { sendTransactionAsync, isPending: isSendingTx } = useSendTransaction();

	const [token0Symbol, setToken0Symbol] = useState<(typeof TOKENS)[number]["symbol"]>(TOKENS[0].symbol);
	const [token1Symbol, setToken1Symbol] = useState<(typeof TOKENS)[number]["symbol"]>(TOKENS[1].symbol);

	const [phase, setPhase] = useState<Phase>("form");
	const [error, setError] = useState<string | null>(null);

	const [hookAddress, setHookAddress] = useState<Address | null>(null);
	const [hookTxHash, setHookTxHash] = useState<Hex | null>(null);
	const [token0FeedAddress, setToken0FeedAddress] = useState<Address | null>(null);
	const [token1FeedAddress, setToken1FeedAddress] = useState<Address | null>(null);
	const [pmmConfigTxHash, setPmmConfigTxHash] = useState<Hex | null>(null);
	const [pmmSubStep, setPmmSubStep] = useState<PmmSubStep>(null);
	const [poolId, setPoolId] = useState<Hex | null>(null);
	const [initTxHash, setInitTxHash] = useState<Hex | null>(null);

	// Required post-success step: the pool the steps above create is empty — nothing to swap
	// against — until this seeds it with real liquidity from the owner's own token balances.
	const [liquidityStatus, setLiquidityStatus] = useState<
		"idle" | "approving-currency0" | "approving-currency1" | "adding" | "done" | "error"
	>("idle");
	const [liquidityError, setLiquidityError] = useState<string | null>(null);
	const [liquidityTxHash, setLiquidityTxHash] = useState<Hex | null>(null);

	// Optional post-success step: register this pool against the shared "Pool B" reference and
	// authorize its hook to actually trigger a capture. Separate from `phase` above since it's not
	// part of the core deploy flow and can't fail the deployment itself.
	const [refPoolStatus, setRefPoolStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
	const [refPoolError, setRefPoolError] = useState<string | null>(null);

	// Also automatic and separate from `phase`: as soon as the pool is live, register it as
	// `/dashboard`'s default so every visitor sees it without a manual contracts.ts edit.
	const [officialPoolStatus, setOfficialPoolStatus] = useState<"idle" | "loading" | "done" | "error">("idle");

	// Also automatic: the hook's own _afterInitialize is supposed to register this pool with
	// DemoMevxRouter on its own, via a low-level fail-open call — which has silently failed before
	// (see demoMevxRouterAbi's comment on `protectedPool`), leaving the arb-spread panel stuck at
	// "0.00%, below threshold" forever with no visible error. Checked and, if needed, fixed right
	// after every init — not optional, since a silent miss here means "Run full demo" would never
	// actually trigger a capture.
	const [poolRegistrationStatus, setPoolRegistrationStatus] = useState<"idle" | "checking" | "fixing" | "ok" | "error">(
		"idle"
	);

	const token0 = useMemo(() => TOKENS.find((t) => t.symbol === token0Symbol)!, [token0Symbol]);
	const token1 = useMemo(() => TOKENS.find((t) => t.symbol === token1Symbol)!, [token1Symbol]);
	const samePairSelected = token0Symbol === token1Symbol;

	// The current showcase pool's hook — independent of `phase`/localStorage, so its on-chain
	// deploy history (see DeployHistoryPanel) shows the same for everyone: the owner in a fresh
	// session, or any guest, not just the browser that actually ran the wizard.
	const [officialPoolAddress, setOfficialPoolAddress] = useState<Address | null>(null);
	useEffect(() => {
		fetch("/api/official-pool")
			.then((res) => res.json())
			.then((data: { hookAddress: Address | null }) => setOfficialPoolAddress(data.hookAddress ?? null))
			.catch(() => setOfficialPoolAddress(null));
	}, []);

	const isWrongNetwork = isConnected && chainId !== sepolia.id;
	const pairLocked = phase !== "form";

	// Resume in-progress/completed deployments on mount (and whenever the connected wallet
	// changes) instead of always starting cold from "form" — a page refresh no longer risks
	// re-deploying a second hook on top of one that's already live for this wallet+pair.
	const resumedFor = useRef<Address | null>(null);
	useEffect(() => {
		if (!address || resumedFor.current === address) return;
		resumedFor.current = address;

		const saved = loadProgress(address);
		if (!saved?.hookAddress) return;

		setToken0Symbol(saved.token0Symbol as (typeof TOKENS)[number]["symbol"]);
		setToken1Symbol(saved.token1Symbol as (typeof TOKENS)[number]["symbol"]);
		setHookAddress(saved.hookAddress);
		setHookTxHash(saved.hookTxHash);
		setToken0FeedAddress(saved.token0FeedAddress);
		setToken1FeedAddress(saved.token1FeedAddress);
		setPmmConfigTxHash(saved.pmmConfigTxHash);
		setPoolId(saved.poolId);
		setInitTxHash(saved.initTxHash);

		// Mid-flight refresh during the (multi-tx) "configuring-pmm" step is a rare edge case —
		// rather than reconstruct exactly which of the 3 sub-steps completed, just fall back to
		// "hook-confirmed" so the visitor can click Step 2 again (redeploying an already-deployed
		// feed wastes a little gas, but nothing breaks).
		if (saved.phase === "configuring-pmm") {
			setPhase("hook-confirmed");
			return;
		}

		if (saved.phase === "success" || saved.phase === "hook-confirmed" || saved.phase === "pmm-configured") {
			setPhase(saved.phase);
			return;
		}

		// Refreshed mid-flight (tx sent but we hadn't yet recorded a confirmation) — check what
		// actually happened on-chain rather than guessing.
		(async () => {
			const pendingHash = saved.initTxHash ?? saved.hookTxHash;
			if (!pendingHash) return;
			try {
				const receipt = await getTransactionReceipt(wagmiConfig, { hash: pendingHash });
				if (receipt.status !== "success") {
					setError("The pending transaction from your last session failed on-chain.");
					clearProgress(address);
					return;
				}
				setPhase(saved.initTxHash ? "success" : "hook-confirmed");
			} catch {
				// Not found yet — still pending (or dropped). Keep waiting for it rather than
				// silently offering to send a competing transaction.
				setPhase(saved.initTxHash ? "confirming-init" : "confirming-hook");
				try {
					const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: pendingHash });
					setPhase(receipt.status === "success" ? (saved.initTxHash ? "success" : "hook-confirmed") : "hook-confirmed");
					if (receipt.status !== "success") {
						setError("The pending transaction from your last session failed on-chain.");
					}
				} catch (err) {
					setError(errorMessage(err));
					setPhase("hook-confirmed");
				}
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [address]);

	// Persist as soon as there's anything worth resuming — including the tx hash the moment it's
	// sent, not just once it's confirmed, so a mid-flight refresh has something to check against.
	useEffect(() => {
		if (!address || !hookAddress) return;
		saveProgress(address, {
			phase,
			hookAddress,
			hookTxHash,
			token0FeedAddress,
			token1FeedAddress,
			pmmConfigTxHash,
			poolId,
			initTxHash,
			token0Symbol,
			token1Symbol,
		});
	}, [
		address,
		phase,
		hookAddress,
		hookTxHash,
		token0FeedAddress,
		token1FeedAddress,
		pmmConfigTxHash,
		poolId,
		initTxHash,
		token0Symbol,
		token1Symbol,
	]);

	// Fires once, the moment the pool goes live — registers it as `/dashboard`'s default so every
	// visitor sees it automatically, no manual contracts.ts edit + redeploy required. Server-side
	// verifies this hook's own owner() before accepting it (see api/official-pool), so this is
	// safe to fire unconditionally rather than gating it on anything client-side.
	useEffect(() => {
		if (phase !== "success" || !hookAddress || officialPoolStatus !== "idle") return;
		setOfficialPoolStatus("loading");
		fetch("/api/official-pool", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hookAddress }),
		})
			.then((res) => res.json().then((json) => ({ ok: res.ok, json })))
			.then(({ ok, json }) => setOfficialPoolStatus(ok && !json.error ? "done" : "error"))
			.catch(() => setOfficialPoolStatus("error"));
	}, [phase, hookAddress, officialPoolStatus]);

	// Also fires once the pool is live: verifies the hook's own _afterInitialize actually
	// registered this pool with the router, and re-registers it directly if not (see
	// poolRegistrationStatus's declaration above for why this can't be skipped).
	// initializePoolExternally has no access control, so any connected wallet could call it — but
	// this only ever runs on the owner-gated wizard in the first place.
	useEffect(() => {
		if (phase !== "success" || !hookAddress || !poolId || poolRegistrationStatus !== "idle") return;
		setPoolRegistrationStatus("checking");
		(async () => {
			try {
				const registered = await readContract(wagmiConfig, {
					address: addresses.demoMevxRouter,
					abi: demoMevxRouterAbi,
					functionName: "protectedPool",
					args: [poolId],
				});
				if (registered[0] !== ZERO_ADDRESS) {
					setPoolRegistrationStatus("ok");
					return;
				}

				setPoolRegistrationStatus("fixing");
				const [sortedCurrency0, sortedCurrency1] = sortCurrencies(token0.address, token1.address);
				const data = encodePacked(
					["address", "address", "uint24", "int24", "address"],
					[sortedCurrency0, sortedCurrency1, POOL_KEY_FEE, TICK_SPACING, hookAddress]
				);
				const txHash = await sendTransactionAsync({
					to: addresses.demoMevxRouter,
					data: encodeFunctionData({
						abi: demoMevxRouterAbi,
						functionName: "initializePoolExternally",
						args: [poolId, UNISWAP_V4_POOL_TYPE, data],
					}),
				});
				const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash });
				setPoolRegistrationStatus(receipt.status === "success" ? "ok" : "error");
			} catch {
				setPoolRegistrationStatus("error");
			}
		})();
	}, [phase, hookAddress, poolId, poolRegistrationStatus, token0, token1]);

	// Also automatic: enables the arbitrage-capture demo (points this pool at the shared Pool B,
	// authorizes its hook to trigger a real capture) the moment the pool is live — no manual click,
	// no separate on-camera step. Server-side (see api/register-reference-pool), so this needs no
	// wallet signature at all. Was a manual, optional "Step 5" button; folded in here so a wizard
	// run always ends fully demo-ready.
	useEffect(() => {
		if (phase !== "success" || !hookAddress || refPoolStatus !== "idle") return;
		registerReferencePool();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase, hookAddress, refPoolStatus]);

	function startOver() {
		if (address) clearProgress(address);
		setPhase("form");
		setError(null);
		setHookAddress(null);
		setHookTxHash(null);
		setToken0FeedAddress(null);
		setToken1FeedAddress(null);
		setPmmConfigTxHash(null);
		setPoolId(null);
		setInitTxHash(null);
		setLiquidityStatus("idle");
		setLiquidityError(null);
		setLiquidityTxHash(null);
		setRefPoolStatus("idle");
		setRefPoolError(null);
		setOfficialPoolStatus("idle");
		setPoolRegistrationStatus("idle");
	}


	async function deployHook() {
		if (!address) return;
		setError(null);
		setPhase("mining");
		try {
			const res = await fetch("/api/mine-hook-salt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					bytecode: hookCreationBytecode,
					constructorArgs: {
						poolManager: addresses.poolManager,
						owner: address,
						mevxRouter: addresses.demoMevxRouter,
						mevxExecutor: addresses.demoMevxExecutor,
						profitDistributor: addresses.demoProfitDistributor,
						dynamicFee: String(CONSTRUCTOR_DYNAMIC_FEE),
					},
				}),
			});
			const json = await res.json();
			if (!res.ok || json.error) {
				throw new Error(json.error ?? `Mining request failed (HTTP ${res.status})`);
			}

			const minedHookAddress = json.hookAddress as Address;
			const deployTx = json.deployTx as { to: Address; data: Hex };

			setHookAddress(minedHookAddress);
			setPhase("awaiting-hook-signature");
			// The CREATE2 factory call is raw calldata (salt + initcode, no function selector) —
			// some wallets' gas estimation handles that poorly and can propose absurdly high
			// limits that RPC providers like Infura then reject outright (cap ~16.7M gas). Set an
			// explicit, generous-but-sane limit instead of leaving it to auto-estimation.
			const nonce = await getFreshNonce(address);
			const txHash = await sendTransactionAsync({ to: deployTx.to, data: deployTx.data, gas: 4_000_000n, nonce });
			setHookTxHash(txHash);
			setPhase("confirming-hook");

			const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash });
			if (receipt.status !== "success") {
				throw new Error("Hook deployment transaction reverted on-chain.");
			}

			setPhase("hook-confirmed");
		} catch (err) {
			setError(errorMessage(err));
			setPhase("form");
		}
	}

	async function configurePmm() {
		if (!hookAddress || !address) return;
		setError(null);
		setPhase("configuring-pmm");
		try {
			setPmmSubStep("feed0");
			const feed0InitCode = (mockAggregatorCreationBytecode +
				encodeAbiParameters([{ type: "uint8" }, { type: "int256" }], [8, INITIAL_USDC_ANSWER]).slice(2)) as Hex;
			const feed0TxHash = await sendTransactionAsync({
				data: feed0InitCode,
				gas: 1_000_000n,
				nonce: await getFreshNonce(address),
			});
			const feed0Receipt = await waitForTransactionReceipt(wagmiConfig, { hash: feed0TxHash });
			if (feed0Receipt.status !== "success" || !feed0Receipt.contractAddress) {
				throw new Error("USDC price feed deployment failed.");
			}
			const feed0Address = feed0Receipt.contractAddress;
			setToken0FeedAddress(feed0Address);

			setPmmSubStep("feed1");
			const feed1InitCode = (mockAggregatorCreationBytecode +
				encodeAbiParameters([{ type: "uint8" }, { type: "int256" }], [8, INITIAL_WETH_ANSWER]).slice(2)) as Hex;
			const feed1TxHash = await sendTransactionAsync({
				data: feed1InitCode,
				gas: 1_000_000n,
				nonce: await getFreshNonce(address),
			});
			const feed1Receipt = await waitForTransactionReceipt(wagmiConfig, { hash: feed1TxHash });
			if (feed1Receipt.status !== "success" || !feed1Receipt.contractAddress) {
				throw new Error("WETH price feed deployment failed.");
			}
			const feed1Address = feed1Receipt.contractAddress;
			setToken1FeedAddress(feed1Address);

			setPmmSubStep("config");
			const configData = encodeFunctionData({
				abi: hookFullAbi,
				functionName: "setPmmConfig",
				args: [
					{
						token0UsdFeed: feed0Address,
						token1UsdFeed: feed1Address,
						token0FeedDecimals: 0,
						token1FeedDecimals: 0,
						baseFee: DEFAULT_FEE_PIPS,
						maxFee: MAX_FEE_PIPS,
						feePerDeviationBps: FEE_PER_DEVIATION_BPS,
						neutralThresholdBps: NEUTRAL_THRESHOLD_BPS,
						maxOracleAge: MAX_ORACLE_AGE,
						observationWindow: OBSERVATION_WINDOW,
						minObservationAge: MIN_OBSERVATION_AGE,
						maxSpotToReferenceDeviationBps: MAX_SPOT_TO_REFERENCE_DEVIATION_BPS,
						maxLimitToSpotDeviationBps: MAX_LIMIT_TO_SPOT_DEVIATION_BPS,
						trackedTokenIsToken0: false,
						enabled: true,
					},
				],
			});
			const configTxHash = await sendTransactionAsync({
				to: hookAddress,
				data: configData,
				gas: 500_000n,
				nonce: await getFreshNonce(address),
			});
			setPmmConfigTxHash(configTxHash);
			const configReceipt = await waitForTransactionReceipt(wagmiConfig, { hash: configTxHash });
			if (configReceipt.status !== "success") {
				throw new Error("Dynamic-fee configuration transaction reverted on-chain.");
			}

			setPhase("pmm-configured");
		} catch (err) {
			setError(errorMessage(err));
			setPhase("hook-confirmed");
		} finally {
			setPmmSubStep(null);
		}
	}

	async function initializePool() {
		if (!hookAddress || !address) return;
		setError(null);
		setPhase("awaiting-init-signature");
		try {
			const [currency0, currency1] = sortCurrencies(token0.address, token1.address);
			const key: PoolKeyStruct = {
				currency0,
				currency1,
				fee: POOL_KEY_FEE,
				tickSpacing: TICK_SPACING,
				hooks: hookAddress,
			};
			setPoolId(computePoolId(key));

			const data = encodeFunctionData({
				abi: poolManagerAbi,
				functionName: "initialize",
				args: [key, SQRT_PRICE_USDC_WETH],
			});
			// initialize() triggers the hook's _afterInitialize, which forwards up to
			// callGasBudget (5M by default) into a nested call — give the outer tx enough
			// headroom to cover that plus its own overhead, explicitly rather than estimated.
			const txHash = await sendTransactionAsync({
				to: addresses.poolManager,
				data,
				gas: 6_000_000n,
				nonce: await getFreshNonce(address),
			});
			setInitTxHash(txHash);
			setPhase("confirming-init");

			const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash });
			if (receipt.status !== "success") {
				throw new Error("Pool initialization transaction reverted on-chain.");
			}

			setPhase("success");
		} catch (err) {
			setError(errorMessage(err));
			setPhase("pmm-configured");
		}
	}

	async function ensureApproval(token: Address, amount: bigint) {
		if (!address) throw new Error("Wallet not connected.");
		const allowance = await readContract(wagmiConfig, {
			address: token,
			abi: erc20Abi,
			functionName: "allowance",
			args: [address, addresses.poolModifyLiquidityTest],
		});
		if (allowance >= amount) return;
		const hash = await sendTransactionAsync({
			to: token,
			data: encodeFunctionData({
				abi: erc20Abi,
				functionName: "approve",
				args: [addresses.poolModifyLiquidityTest, maxUint256],
			}),
			nonce: await getFreshNonce(address),
		});
		await waitForTransactionReceipt(wagmiConfig, { hash });
	}

	async function addLiquidity() {
		if (!hookAddress || !address) return;
		setLiquidityError(null);
		try {
			const [currency0, currency1] = sortCurrencies(token0.address, token1.address);
			const key: PoolKeyStruct = {
				currency0,
				currency1,
				fee: POOL_KEY_FEE,
				tickSpacing: TICK_SPACING,
				hooks: hookAddress,
			};

			setLiquidityStatus("approving-currency0");
			await ensureApproval(currency0, maxUint256);
			setLiquidityStatus("approving-currency1");
			await ensureApproval(currency1, maxUint256);

			setLiquidityStatus("adding");
			const data = encodeFunctionData({
				abi: poolModifyLiquidityTestAbi,
				functionName: "modifyLiquidity",
				args: [
					key,
					{
						tickLower: LIQUIDITY_TICK_LOWER,
						tickUpper: LIQUIDITY_TICK_UPPER,
						liquidityDelta: LIQUIDITY_DELTA,
						salt: zeroHash,
					},
					"0x",
				],
			});

			// No auto-retry here on purpose: a wallet can throw client-side even after a transaction
			// was genuinely broadcast (RPC/bridge hiccup on the *response*, not the send), and blindly
			// resending races the wallet's own nonce cache — exactly the "nonce provided is lower than
			// the current nonce" failure this used to cause. Passing an explicitly-fetched nonce (see
			// getFreshNonce) instead of leaving the wallet to guess its own already fixes that class of
			// failure; a stuck send beyond that is rare enough that surfacing it and letting the person
			// click the button again is safer than an automatic retry here.
			const txHash = await sendTransactionAsync({
				to: addresses.poolModifyLiquidityTest,
				data,
				gas: 2_000_000n,
				nonce: await getFreshNonce(address),
			});

			setLiquidityTxHash(txHash);
			const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash });
			if (receipt.status !== "success") {
				throw new Error("Add-liquidity transaction reverted on-chain.");
			}

			setLiquidityStatus("done");
		} catch (err) {
			setLiquidityError(errorMessage(err));
			setLiquidityStatus("error");
		}
	}

	// The route itself is idempotent (checks hasReferencePool/isAuthorized before writing anything),
	// so retrying on a transient failure (single public RPC endpoint, no fallback) is always safe —
	// self-heals a one-off hiccup instead of silently stranding "Run full demo" on the dashboard.
	const REGISTER_REFERENCE_POOL_ATTEMPTS = 3;

	async function registerReferencePool() {
		if (!hookAddress) return;
		setRefPoolStatus("loading");
		setRefPoolError(null);
		let lastError: unknown;
		for (let attempt = 1; attempt <= REGISTER_REFERENCE_POOL_ATTEMPTS; attempt++) {
			try {
				const res = await fetch("/api/register-reference-pool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ hookAddress }),
				});
				const json = await res.json();
				if (!res.ok || json.error) {
					throw new Error(json.error ?? `Registration failed (HTTP ${res.status})`);
				}
				setRefPoolStatus("done");
				return;
			} catch (err) {
				lastError = err;
				if (attempt < REGISTER_REFERENCE_POOL_ATTEMPTS) {
					await new Promise((r) => setTimeout(r, 2000));
				}
			}
		}
		setRefPoolError(errorMessage(lastError));
		setRefPoolStatus("error");
	}

	const step1Busy = phase === "mining" || phase === "awaiting-hook-signature" || phase === "confirming-hook";
	const step1Done =
		phase === "hook-confirmed" ||
		phase === "configuring-pmm" ||
		phase === "pmm-configured" ||
		phase === "awaiting-init-signature" ||
		phase === "confirming-init" ||
		phase === "success";

	const step2Busy = phase === "configuring-pmm";
	const step2Done = phase === "pmm-configured" || phase === "awaiting-init-signature" || phase === "confirming-init" || phase === "success";

	const step3Busy = phase === "awaiting-init-signature" || phase === "confirming-init";
	const step3Done = phase === "success";

	const pmmSubStepLabel: Record<Exclude<PmmSubStep, null>, string> = {
		feed0: "Deploying USDC price feed…",
		feed1: "Deploying WETH price feed…",
		config: "Confirm in wallet…",
	};

	return (
		<div className="max-w-2xl mx-auto px-6 py-16">
			<p className="label-caps mb-3">Sepolia · Uniswap v4</p>
			<h1 className="text-3xl mb-3 text-white">Deploy a Homelander-protected pool</h1>
			<p className="text-neutral-400 mb-8">
				The single showcase pool everyone sees on the dashboard — owner-only. Deploys{" "}
				<code className="text-neutral-300">HomelanderUniV4PluginChainlinkPmm</code> with its own price feeds
				and initializes the pool on Sepolia.
			</p>

			<div className="mb-6">
				<DeployHistoryPanel hookAddress={officialPoolAddress} />
			</div>

			{(!isConnected || !isOwner) && (
				<div className="glass-panel p-6 flex flex-col items-start gap-4">
					<p className="text-neutral-300">
						This is a single-pool showcase — deployment is restricted to the project owner&apos;s wallet.
					</p>
					<p className="text-sm text-neutral-500">
						Everyone else gets a read-only view of the live showcase pool.
					</p>
					<div className="flex flex-wrap items-center gap-4">
						<Link
							href="/dashboard"
							className="px-5 py-3 rounded-full bg-white text-neutral-900 font-semibold text-sm hover:bg-white/90 transition-colors"
						>
							View the live pool
						</Link>
						{!isConnected && <ConnectButton />}
					</div>
				</div>
			)}

			{isConnected && isOwner && isWrongNetwork && (
				<div className="glass-panel border-amber-400/30 bg-amber-500/[0.04] p-6 flex flex-col items-start gap-4">
					<p className="text-amber-200">
						Wrong network — this demo only runs on Sepolia. Switch networks to continue.
					</p>
					<button
						type="button"
						onClick={() => switchChain({ chainId: sepolia.id })}
						disabled={isSwitching}
						className="px-4 py-2 rounded-lg bg-amber-400 text-neutral-950 font-medium text-sm disabled:opacity-50"
					>
						{isSwitching ? "Switching…" : "Switch to Sepolia"}
					</button>
				</div>
			)}

			{isConnected && isOwner && !isWrongNetwork && (
				<div className="flex flex-col gap-6">
					{/* Pair picker */}
					<section className="glass-panel p-6">
						<h2 className="label-caps mb-4">Token pair</h2>
						<div className="flex items-center gap-3">
							<select
								value={token0Symbol}
								disabled={pairLocked}
								onChange={(e) => setToken0Symbol(e.target.value as (typeof TOKENS)[number]["symbol"])}
								className="flex-1 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm disabled:opacity-50"
							>
								{TOKENS.map((t) => (
									<option key={t.symbol} value={t.symbol}>
										{t.symbol}
									</option>
								))}
							</select>
							<span className="text-neutral-500">/</span>
							<select
								value={token1Symbol}
								disabled={pairLocked}
								onChange={(e) => setToken1Symbol(e.target.value as (typeof TOKENS)[number]["symbol"])}
								className="flex-1 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm disabled:opacity-50"
							>
								{TOKENS.map((t) => (
									<option key={t.symbol} value={t.symbol}>
										{t.symbol}
									</option>
								))}
							</select>
						</div>
						{samePairSelected && (
							<p className="text-red-400 text-xs mt-2">Pick two different tokens.</p>
						)}
						<p className="text-neutral-500 text-xs mt-3">
							Dynamic fee: 0.30% base, up to 1.00%, driven by the Chainlink feeds from Step 2.
							Bootstraps at ~2500 USDC/WETH. This only creates the pool — liquidity is added
							separately.
						</p>
					</section>

					{/* Step 1 */}
					<section className="glass-panel p-6">
						<div className="flex items-center justify-between mb-3">
							<h2 className="label-caps">Step 1 — Deploy hook contract</h2>
							{step1Done && <span className="text-xs text-emerald-400">Done</span>}
						</div>

						<p className="text-xs text-neutral-500 mb-3 break-all min-h-4">
							{hookAddress ? (
								<>
									Hook address:{" "}
									<a
										href={etherscanAddress(hookAddress)}
										target="_blank"
										rel="noreferrer"
										className="text-neutral-300 hover:underline"
									>
										{hookAddress}
									</a>
								</>
							) : (
								" "
							)}
						</p>
						<p className="text-xs text-neutral-500 mb-3 break-all min-h-4">
							{hookTxHash ? (
								<>
									Deploy tx:{" "}
									<a
										href={etherscanTx(hookTxHash)}
										target="_blank"
										rel="noreferrer"
										className="text-neutral-300 hover:underline"
									>
										{hookTxHash}
									</a>
								</>
							) : (
								" "
							)}
						</p>

						{!step1Done && (
							<button
								type="button"
								onClick={deployHook}
								disabled={samePairSelected || step1Busy || isSendingTx}
								className="px-4 py-2 rounded-lg bg-neutral-100 text-neutral-950 font-medium text-sm disabled:opacity-50"
							>
								{phase === "mining" && "Mining hook address…"}
								{phase === "awaiting-hook-signature" && "Confirm in wallet…"}
								{phase === "confirming-hook" && "Waiting for confirmation…"}
								{phase === "form" && "Deploy hook"}
							</button>
						)}
					</section>

					{/* Step 2 */}
					<section className={`glass-panel p-6 ${!step1Done ? "opacity-40" : ""}`}>
						<div className="flex items-center justify-between mb-3">
							<h2 className="label-caps">Step 2 — Configure dynamic fee</h2>
							{step2Done && <span className="text-xs text-emerald-400">Done</span>}
						</div>
						<p className="text-xs text-neutral-500 mb-3">
							Deploys the USDC and WETH feed contracts (owner-controlled, same mechanism as the
							showcase pool&apos;s &quot;Simulate shock&quot; button), then wires them into the hook —
							three transactions, chained automatically.
						</p>

						<p className="text-xs text-neutral-500 mb-1 break-all min-h-4">
							{token0FeedAddress ? (
								<>
									USDC feed: <span className="text-neutral-300">{token0FeedAddress}</span>
								</>
							) : (
								" "
							)}
						</p>
						<p className="text-xs text-neutral-500 mb-3 break-all min-h-4">
							{token1FeedAddress ? (
								<>
									WETH feed: <span className="text-neutral-300">{token1FeedAddress}</span>
								</>
							) : (
								" "
							)}
						</p>
						<p className="text-xs text-neutral-500 mb-3 break-all min-h-4">
							{pmmConfigTxHash ? (
								<>
									Config tx:{" "}
									<a
										href={etherscanTx(pmmConfigTxHash)}
										target="_blank"
										rel="noreferrer"
										className="text-neutral-300 hover:underline"
									>
										{pmmConfigTxHash}
									</a>
								</>
							) : (
								" "
							)}
						</p>

						{step1Done && !step2Done && (
							<button
								type="button"
								onClick={configurePmm}
								disabled={step2Busy || isSendingTx}
								className="px-4 py-2 rounded-lg bg-neutral-100 text-neutral-950 font-medium text-sm disabled:opacity-50"
							>
								{step2Busy && pmmSubStep ? pmmSubStepLabel[pmmSubStep] : "Configure dynamic fee"}
							</button>
						)}
						{!step1Done && <p className="text-xs text-neutral-500">Deploy the hook first.</p>}
					</section>

					{/* Step 3 */}
					<section className={`glass-panel p-6 ${!step2Done ? "opacity-40" : ""}`}>
						<div className="flex items-center justify-between mb-3">
							<h2 className="label-caps">Step 3 — Initialize pool</h2>
							{step3Done && <span className="text-xs text-emerald-400">Done</span>}
						</div>

						<p className="text-xs text-neutral-500 mb-3 break-all min-h-4">
							{initTxHash ? (
								<>
									Initialize tx:{" "}
									<a
										href={etherscanTx(initTxHash)}
										target="_blank"
										rel="noreferrer"
										className="text-neutral-300 hover:underline"
									>
										{initTxHash}
									</a>
								</>
							) : (
								" "
							)}
						</p>

						{step2Done && !step3Done && (
							<button
								type="button"
								onClick={initializePool}
								disabled={step3Busy || isSendingTx}
								className="px-4 py-2 rounded-lg bg-neutral-100 text-neutral-950 font-medium text-sm disabled:opacity-50"
							>
								{phase === "awaiting-init-signature" && "Confirm in wallet…"}
								{phase === "confirming-init" && "Waiting for confirmation…"}
								{phase === "pmm-configured" && `Initialize ${token0Symbol}/${token1Symbol} pool`}
							</button>
						)}
						{!step2Done && <p className="text-xs text-neutral-500">Configure the dynamic fee first.</p>}
					</section>

					{error && (
						<div className="glass-panel border-red-500/30 bg-red-500/[0.05] p-4 text-sm text-red-300 break-words">
							{error}
						</div>
					)}

					{(() => {
						const poolLive = phase === "success" && !!hookAddress && !!poolId;
						return (
						<section
							className={`glass-panel border-emerald-400/30 bg-emerald-500/[0.05] p-6 flex flex-col gap-3 ${!poolLive ? "opacity-40 pointer-events-none" : ""}`}
						>
							<h2 className="label-caps text-emerald-300">Pool live</h2>
							<p className="text-xs text-neutral-400 break-all">
								Pool ID: <span className="text-neutral-200">{poolId ?? "—"}</span>
							</p>
							<p className="text-xs text-neutral-400 break-all">
								Hook: <span className="text-neutral-200">{hookAddress ?? "—"}</span>
							</p>
							<p className="text-xs text-neutral-500 min-h-4">
								{officialPoolStatus === "loading" && "Registering as the dashboard's default pool…"}
								{officialPoolStatus === "done" && "Set as the dashboard's default — every visitor sees this pool now."}
								{officialPoolStatus === "error" &&
									"Couldn't register this as the default automatically — the dashboard link above still works."}
								{officialPoolStatus === "idle" && " "}
							</p>
							<p className="text-xs text-neutral-500 min-h-4">
								{poolRegistrationStatus === "checking" && "Verifying the pool registered itself with the arb router…"}
								{poolRegistrationStatus === "fixing" &&
									"Registration didn't happen automatically — fixing it now (1 more confirmation)…"}
								{poolRegistrationStatus === "ok" && "Arb-spread detection confirmed working for this pool."}
								{poolRegistrationStatus === "error" &&
									"Couldn't verify or fix arb-router registration — the arbitrage-spread panel may read 0% until this is resolved."}
								{poolRegistrationStatus === "idle" && " "}
							</p>
							<p className="text-xs text-neutral-500 flex items-center gap-2 flex-wrap min-h-4">
								{refPoolStatus === "idle" && " "}
								{refPoolStatus === "loading" && "Enabling the MEV-capture demo…"}
								{refPoolStatus === "done" &&
									"MEV-capture demo enabled — Pool B is ready, \"Run full demo\" works immediately on the dashboard."}
								{refPoolStatus === "error" && (
									<>
										<span className="text-red-400 break-words">
											Couldn&apos;t enable the MEV-capture demo automatically{refPoolError ? `: ${refPoolError}` : "."}
										</span>
										<button
											type="button"
											onClick={registerReferencePool}
											className="px-2 py-1 rounded border border-white/15 text-neutral-300"
										>
											Retry
										</button>
									</>
								)}
							</p>
							<div className="mt-2 flex gap-3">
								<Link
									href={hookAddress ? `/dashboard?hook=${hookAddress}` : "/dashboard"}
									className="self-start px-4 py-2 rounded-lg bg-emerald-400 text-neutral-950 font-medium text-sm"
								>
									View in dashboard
								</Link>
								<button
									type="button"
									onClick={startOver}
									className="self-start px-4 py-2 rounded-lg border border-white/15 text-sm text-neutral-300"
								>
									Deploy another pool
								</button>
							</div>
						</section>
						);
					})()}

					{(() => {
						const step4Ready = phase === "success" && !!hookAddress;
						return (
						<section className={`glass-panel p-6 flex flex-col gap-3 ${!step4Ready ? "opacity-40 pointer-events-none" : ""}`}>
							<div className="flex items-center justify-between">
								<h2 className="label-caps">Step 4 — Add liquidity</h2>
								{liquidityStatus === "done" && <span className="text-xs text-emerald-400">Done</span>}
							</div>
							<p className="text-xs text-neutral-500">
								The pool above is empty — nothing to swap against yet. Seeds it with real liquidity from
								your own {token0Symbol}/{token1Symbol} balance, in a band around the bootstrap price. Two
								approvals plus the add-liquidity transaction.
							</p>
							<p className="text-xs text-neutral-500 break-all min-h-4">
								{liquidityTxHash ? (
									<>
										Add-liquidity tx:{" "}
										<a
											href={etherscanTx(liquidityTxHash)}
											target="_blank"
											rel="noreferrer"
											className="text-neutral-300 hover:underline"
										>
											{liquidityTxHash}
										</a>
									</>
								) : (
									" "
								)}
							</p>
							{liquidityStatus !== "done" && (
								<button
									type="button"
									onClick={addLiquidity}
									disabled={
										!step4Ready ||
										liquidityStatus === "approving-currency0" ||
										liquidityStatus === "approving-currency1" ||
										liquidityStatus === "adding"
									}
									className="self-start px-4 py-2 rounded-lg bg-neutral-100 text-neutral-950 font-medium text-sm disabled:opacity-50"
								>
									{liquidityStatus === "approving-currency0" && `Approve ${token0Symbol}…`}
									{liquidityStatus === "approving-currency1" && `Approve ${token1Symbol}…`}
									{liquidityStatus === "adding" && "Adding liquidity…"}
									{(liquidityStatus === "idle" || liquidityStatus === "error") && "Add liquidity"}
								</button>
							)}
							<p className="text-xs break-words min-h-4">
								{liquidityStatus === "done" && (
									<span className="text-emerald-400">Done — the pool can now be swapped against.</span>
								)}
								{liquidityStatus === "error" && liquidityError && (
									<span className="text-red-400">{liquidityError}</span>
								)}
								{!(liquidityStatus === "done" || (liquidityStatus === "error" && liquidityError)) && " "}
							</p>
						</section>
						);
					})()}

				</div>
			)}
		</div>
	);
}
