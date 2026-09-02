// Minimal Uniswap v4-core PoolModifyLiquidityTest ABI fragment — just what this wizard needs to
// call `modifyLiquidity(key, params, hookData)` on the real Sepolia test router
// (addresses.poolModifyLiquidityTest). Same test-router pattern the app's own contract test suite
// (test/homelanderUniV4Plugin.chainlinkFee.test.ts) and SwapWidget.tsx's PoolSwapTest use.
export const poolModifyLiquidityTestAbi = [
	{
		type: "function",
		name: "modifyLiquidity",
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
					{ name: "tickLower", type: "int24" },
					{ name: "tickUpper", type: "int24" },
					{ name: "liquidityDelta", type: "int256" },
					{ name: "salt", type: "bytes32" },
				],
			},
			{ name: "hookData", type: "bytes" },
		],
		outputs: [{ name: "delta", type: "int256" }],
	},
] as const;
