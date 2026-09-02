import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { addresses } from "./contracts";

/** Uniswap v4 dynamic-fee sentinel bit (LPFeeLibrary.DYNAMIC_FEE_FLAG). Set alone (no static
 * fee pips) in a pool's `PoolKey.fee` field to mark it as a dynamic-fee pool — the actual fee
 * is decided per-swap by the hook (see HomelanderUniV4PluginChainlinkPmm.dynamicFee / _feeForSender). */
export const DYNAMIC_FEE_FLAG = 0x800000;

/** Tick spacing the deploy wizard uses for every pool it creates through this app. */
export const DEFAULT_TICK_SPACING = 60;

// TickMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE (@uniswap/v4-core src/libraries/TickMath.sol) — the
// same "no real limit" price bounds the contract test suite's PoolSwapTest calls use.
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

export interface PoolKeyStruct {
	currency0: Address;
	currency1: Address;
	fee: number;
	tickSpacing: number;
	hooks: Address;
}

/** PoolManager requires currency0 < currency1 by raw address value. */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
	return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/**
 * Reconstructs the PoolKey for a pool created through this app's own deploy wizard: WETH/USDC,
 * dynamic fee, tickSpacing 60, hooked by `hookAddress`. See the dashboard build report for why
 * this assumption (rather than an on-chain lookup) is used — the hook contract exposes no
 * getter that returns its own PoolKey, and this page may only ever receive a bare `?hook=`
 * address.
 */
export function buildDemoPoolKey(hookAddress: Address): PoolKeyStruct {
	const [currency0, currency1] = sortCurrencies(addresses.weth, addresses.usdc);
	return {
		currency0,
		currency1,
		fee: DYNAMIC_FEE_FLAG,
		tickSpacing: DEFAULT_TICK_SPACING,
		hooks: hookAddress,
	};
}

/** Mirrors @uniswap/v4-core's `PoolIdLibrary.toId` — keccak256 of the abi-encoded PoolKey struct
 * fields (address, address, uint24, int24, address), each word-padded exactly like the Solidity
 * struct's in-memory layout. */
export function computePoolId(key: PoolKeyStruct): Hex {
	return keccak256(
		encodeAbiParameters(
			[{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
			[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
		)
	);
}
