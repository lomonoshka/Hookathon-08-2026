// Minimal Uniswap v4 PoolManager ABI fragment — just what this wizard needs to call
// `initialize(key, sqrtPriceX96)` on the real Sepolia PoolManager (addresses.poolManager).
// Source of truth for the shape: @uniswap/v4-core/src/interfaces/IPoolManager.sol and
// @uniswap/v4-core/src/types/PoolKey.sol (installed under contracts/node_modules in the sibling
// Hardhat project). Not copied wholesale like hookArtifact.ts because PoolManager is already
// deployed on Sepolia — we only need the call-encoding shape, not its bytecode.
export const poolManagerAbi = [
	{
		type: "function",
		name: "initialize",
		stateMutability: "nonpayable",
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
			{ name: "sqrtPriceX96", type: "uint160" },
		],
		outputs: [{ name: "tick", type: "int24" }],
	},
	{
		type: "event",
		anonymous: false,
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
] as const;
