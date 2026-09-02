import type { Address } from "viem";

// This is a single-pool showcase, not a public multi-tenant demo: only this wallet can deploy a
// pool through `/deploy`, and every interactive control on `/dashboard` (swap, one-click demo,
// price shock, push Pool B) only renders for this connected wallet. Everyone else — including a
// disconnected visitor — gets a pure read-only view of the one showcase pool's live stats. See
// `useIsOwner` in `useIsOwner.ts`.
export const OWNER_ADDRESS: Address = "0xc2bA6279D17f3F72F7283FB99DC094aE8A54BA0c";

// Filled in by the deploy script once contracts are live on Sepolia. Keep this the single
// source of truth for addresses — both the deploy wizard and the dashboard import from here.
// Live on Sepolia — see /home/node/Hookathon-08-2026/deployments-sepolia.json (written by
// scripts/deploySepolia.ts) for the deploy record.
export const addresses = {
	poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543" as Address,
	poolSwapTest: "0xc77D59b833CAc182D3B23D504C8C6cda1bdDF998" as Address,
	poolModifyLiquidityTest: "0x9Fc6aA92eDECEbb4DC413DaBAfBbe03F8787958A" as Address,
	weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as Address,
	usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,
	chainlinkEthUsdFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306" as Address, // real Chainlink feed — default for wizard-created pools
	demoMevxRouter: "0x32a9946EfDeaA408510B18649dea6888a099E005" as Address,
	// Redeployed twice 2026-09-01. First: the original executor routed its capture swaps through
	// PoolSwapTest, which always calls PoolManager.unlock() itself — but executeRoute always runs
	// *inside* a hook's _afterSwap (an already-unlocked PoolManager), so every real capture attempt
	// reverted with AlreadyUnlocked, silently swallowed by the hook's fail-open try/catch. Every
	// "MEV captured" panel showing "No arbitrage captured yet" all session was this bug, not a
	// threshold issue — fixed by calling PoolManager.swap() directly (CurrencySettler for
	// settlement). Second: authorizedCaller was a single address (whichever hook was authorized
	// most recently), so enabling a visitor's own wizard-deployed pool would silently break capture
	// on the showcase pool — fixed by making it a set (authorizedCallers mapping) instead. See
	// contracts/demo-arbitrage/DemoMevxExecutor.sol and scripts/redeployExecutorMultiCaller.ts.
	demoMevxExecutor: "0xEeEd02224F9bddCF627511F81DCe34924221819E" as Address,
	demoProfitDistributor: "0xF2337757b542a831858D83e06E75325DDEFB6670" as Address,
	// No `demoHook` here anymore — the default showcase pool is whatever the owner's wizard last
	// registered via POST /api/official-pool (see that route and DashboardContent.tsx), not a
	// hardcoded address that needs a code change + redeploy every time it changes.
} as const;

// HomelanderUniV4PluginChainlinkPmm — the showcase demo pool's hook. See
// contracts/HomelanderUniV4PluginChainlinkPmm.sol for the full contract; only the
// dashboard-relevant read surface is declared here.
//
// `pmmConfig()` is a public struct-typed state var — Solidity's auto-generated getter flattens
// every field into its own positional return value (not a single tuple), so this decodes as an
// array indexable both positionally and (per viem) by name. Every field here is uint8/16/24/32,
// address, or bool — all decode as plain JS number/string/boolean, never bigint (see
// DashboardContent.tsx for the general uint8..uint48-vs-uint56+ number/bigint split this app
// relies on; nothing in this struct crosses that uint56 line).
export const hookAbi = [
	{ type: "function", name: "dynamicFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
	{ type: "function", name: "mevxExecutor", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{
		type: "function",
		name: "pmmConfig",
		stateMutability: "view",
		inputs: [],
		outputs: [
			{ name: "token0UsdFeed", type: "address" },
			{ name: "token1UsdFeed", type: "address" },
			{ name: "token0FeedDecimals", type: "uint8" },
			{ name: "token1FeedDecimals", type: "uint8" },
			{ name: "baseFee", type: "uint24" },
			{ name: "maxFee", type: "uint24" },
			{ name: "feePerDeviationBps", type: "uint24" },
			{ name: "neutralThresholdBps", type: "uint16" },
			{ name: "maxOracleAge", type: "uint32" },
			{ name: "observationWindow", type: "uint32" },
			{ name: "minObservationAge", type: "uint32" },
			{ name: "maxSpotToReferenceDeviationBps", type: "uint16" },
			{ name: "maxLimitToSpotDeviationBps", type: "uint16" },
			{ name: "trackedTokenIsToken0", type: "bool" },
			{ name: "enabled", type: "bool" },
		],
	},
	// uint256 — decodes as bigint, unlike everything in pmmConfig() above.
	{ type: "function", name: "referencePoolPriceWei", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
	{ type: "function", name: "pendingPoolPriceWei", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
	{ type: "function", name: "observationCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

export const mockAggregatorAbi = [
	{
		type: "function",
		name: "updateAnswer",
		stateMutability: "nonpayable",
		inputs: [{ name: "_answer", type: "int256" }],
		outputs: [],
	},
	{
		type: "function",
		name: "latestAnswer",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "int256" }],
	},
] as const;

export const erc20Abi = [
	{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
	{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
	{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [{ type: "bool" }],
	},
	// Added for the dashboard's swap-widget allowance check (approve-before-swap flow).
	{
		type: "function",
		name: "allowance",
		stateMutability: "view",
		inputs: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
		],
		outputs: [{ type: "uint256" }],
	},
] as const;

// Uniswap v4-core's PoolSwapTest — the official test-router pattern this repo's own test suite
// (test/homelanderUniV4Plugin.chainlinkFee.test.ts) uses to exercise swaps. Matches
// PoolSwapTest.sol's `swap(PoolKey, SwapParams, TestSettings, bytes)` exactly. Used by the
// dashboard's swap widget against `addresses.poolSwapTest`.
export const poolSwapTestAbi = [
	{
		type: "function",
		name: "swap",
		stateMutability: "payable",
		inputs: [
			{
				name: "key",
				type: "tuple",
				components: [
					{ name: "currency0", type: "address" },
					{ name: "currency1", type: "address" },
					{ name: "fee", type: "uint24" },
					{ name: "tickSpacing", type: "int24" },
					{ name: "hooks", type: "address" },
				],
			},
			{
				name: "params",
				type: "tuple",
				components: [
					{ name: "zeroForOne", type: "bool" },
					{ name: "amountSpecified", type: "int256" },
					{ name: "sqrtPriceLimitX96", type: "uint160" },
				],
			},
			{
				name: "testSettings",
				type: "tuple",
				components: [
					{ name: "takeClaims", type: "bool" },
					{ name: "settleUsingBurn", type: "bool" },
				],
			},
			{ name: "hookData", type: "bytes" },
		],
		outputs: [{ name: "delta", type: "int256" }],
	},
] as const;

// PoolManager's Swap event — the applied `fee` field is what proves the Chainlink tier logic
// actually ran (see the contract test suite for the same assertion pattern).
export const poolManagerSwapEventAbi = [
	{
		type: "event",
		name: "Swap",
		inputs: [
			{ indexed: true, name: "id", type: "bytes32" },
			{ indexed: true, name: "sender", type: "address" },
			{ indexed: false, name: "amount0", type: "int128" },
			{ indexed: false, name: "amount1", type: "int128" },
			{ indexed: false, name: "sqrtPriceX96", type: "uint160" },
			{ indexed: false, name: "liquidity", type: "uint128" },
			{ indexed: false, name: "tick", type: "int24" },
			{ indexed: false, name: "fee", type: "uint24" },
		],
	},
] as const;

// PoolManager's Initialize/ModifyLiquidity events — used to reconstruct a pool's deploy history
// from on-chain data alone (see lib/deployHistory.ts), rather than relying on the deploy wizard's
// own localStorage progress, which only ever exists in the one browser that ran it.
export const poolManagerLifecycleEventAbi = [
	{
		type: "event",
		name: "Initialize",
		inputs: [
			{ indexed: true, name: "id", type: "bytes32" },
			{ indexed: true, name: "currency0", type: "address" },
			{ indexed: true, name: "currency1", type: "address" },
			{ indexed: false, name: "fee", type: "uint24" },
			{ indexed: false, name: "tickSpacing", type: "int24" },
			{ indexed: false, name: "hooks", type: "address" },
			{ indexed: false, name: "sqrtPriceX96", type: "uint160" },
			{ indexed: false, name: "tick", type: "int24" },
		],
	},
	{
		type: "event",
		name: "ModifyLiquidity",
		inputs: [
			{ indexed: true, name: "id", type: "bytes32" },
			{ indexed: true, name: "sender", type: "address" },
			{ indexed: false, name: "tickLower", type: "int24" },
			{ indexed: false, name: "tickUpper", type: "int24" },
			{ indexed: false, name: "liquidityDelta", type: "int256" },
			{ indexed: false, name: "salt", type: "bytes32" },
		],
	},
] as const;

// DemoMevxRouter — hackathon-original arbitrage router (contracts/demo-arbitrage/DemoMevxRouter.sol).
// Only the read-only surface the dashboard needs: the live spread check (`initialArbCheck`, the
// exact function the hook itself calls), the configured minimum-spread threshold, and the
// registered reference pool ("Pool B") used to manufacture a demo price gap.
export const demoMevxRouterAbi = [
	{
		type: "function",
		name: "initialArbCheck",
		stateMutability: "view",
		inputs: [
			{ name: "poolId", type: "bytes32" },
			{ name: "", type: "bool" },
		],
		outputs: [
			{ name: "isArbPossible", type: "bool" },
			{ name: "priceChange", type: "bytes16" },
		],
	},
	{
		type: "function",
		name: "minSpreadBps",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "uint256" }],
	},
	{
		type: "function",
		name: "hasReferencePool",
		stateMutability: "view",
		inputs: [{ name: "poolId", type: "bytes32" }],
		outputs: [{ type: "bool" }],
	},
	{
		type: "function",
		name: "referencePool",
		stateMutability: "view",
		inputs: [{ name: "poolId", type: "bytes32" }],
		outputs: [
			{ name: "currency0", type: "address" },
			{ name: "currency1", type: "address" },
			{ name: "fee", type: "uint24" },
			{ name: "tickSpacing", type: "int24" },
			{ name: "hooks", type: "address" },
		],
	},
	// onlyOwner — only callable server-side, from api/register-reference-pool, using the router
	// owner's key. Never called directly from a connected wallet.
	{
		type: "function",
		name: "setReferencePool",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "poolId", type: "bytes32" },
			{
				name: "refKey",
				type: "tuple",
				components: [
					{ name: "currency0", type: "address" },
					{ name: "currency1", type: "address" },
					{ name: "fee", type: "uint24" },
					{ name: "tickSpacing", type: "int24" },
					{ name: "hooks", type: "address" },
				],
			},
		],
		outputs: [],
	},
	// The hook's own `_afterInitialize` is supposed to register this automatically via a
	// low-level, fail-open `.call()` — but that call has silently failed before (see
	// scripts/fixProtectedPoolRegistration.ts's original discovery), leaving `protectedPool`
	// empty and `initialArbCheck` permanently stuck at (false, 0) with no error anywhere. Reading
	// this after every pool init and re-registering if it's still zero (see app/deploy/page.tsx)
	// is the actual fix — no access control on the function, so any wallet can call it.
	{
		type: "function",
		name: "protectedPool",
		stateMutability: "view",
		inputs: [{ name: "poolId", type: "bytes32" }],
		outputs: [
			{ name: "currency0", type: "address" },
			{ name: "currency1", type: "address" },
			{ name: "fee", type: "uint24" },
			{ name: "tickSpacing", type: "int24" },
			{ name: "hooks", type: "address" },
		],
	},
	{
		type: "function",
		name: "initializePoolExternally",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "poolId", type: "bytes32" },
			{ name: "poolType", type: "uint16" },
			{ name: "data", type: "bytes" },
		],
		outputs: [],
	},
] as const;

// DemoMevxExecutor (contracts/demo-arbitrage/DemoMevxExecutor.sol).
export const demoMevxExecutorAbi = [
	{
		type: "event",
		name: "ArbitrageExecuted",
		inputs: [
			{ indexed: true, name: "profitToken", type: "address" },
			{ indexed: true, name: "profitRecipient", type: "address" },
			{ indexed: false, name: "profit", type: "uint256" },
		],
	},
	// Real capture only actually executes for a hook in this set — read by the dashboard to know
	// whether to show the "spread only, no auto-capture" caveat for a given pool.
	{
		type: "function",
		name: "authorizedCallers",
		stateMutability: "view",
		inputs: [{ name: "caller", type: "address" }],
		outputs: [{ type: "bool" }],
	},
	// onlyOwner — only callable server-side, from api/register-reference-pool, using the
	// executor owner's key. Never called directly from a connected wallet.
	{
		type: "function",
		name: "setAuthorizedCaller",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "caller", type: "address" },
			{ name: "authorized", type: "bool" },
		],
		outputs: [],
	},
] as const;
