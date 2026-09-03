import { ethers } from 'ethers';
import { CREATE2_DEPLOYER, HookFlags, mineHookSalt } from '../../helper-tools/uniswapV4/hookMiner';

/** Base mainnet addresses of the deployed Homelander plugin stack (deployments/base_homelander_v4_factory). */
export const BASE = {
	poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
	stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
	mevxRouter: '0x9e0Edb64d2F8962B7Eff3D7755A54d97A9319E33',
	mevxExecutor: '0x5278414a6F98322F2D66D0473A1B21Fd84AfeeFd',
	profitDistributor: '0x55434F43BfB04839d53A2cA017E40614EB954B80',
	weth: '0x4200000000000000000000000000000000000006',
	usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	/** Uniswap V3 WETH/USDC 0.05% — the deep side of the arbitrage cycle. */
	v3WethUsdc: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
	/** Owner of MevxRouterProxy; also its implicit route manager. */
	routerOwner: '0x000000077aC13A2fc7C7A154D28e6251A5e4648b',
} as const;

/** LPFeeLibrary.DYNAMIC_FEE_FLAG. A pool key must carry exactly this to be a dynamic-fee pool;
 * any extra bits make it a static fee above MAX_LP_FEE and initialize reverts LPFeeTooLarge. */
export const POOL_FEE = 0x800000;
/** The plugin's own config: dynamic-fee sentinel | the default fee pips it applies per swap.
 * Not the same field as the pool key fee above. */
export const PLUGIN_DYNAMIC_FEE = 0x800000 | 500;
export const TICK_SPACING = 10;

/**
 * Owner passed to the plugin constructor. It is part of the CREATE2 init code, so it decides the
 * hook address and therefore the poolId the routes are keyed by — the fork test has to use the
 * same value the mainnet deploy will, not whatever local account happens to be first.
 */
export const PLUGIN_OWNER = process.env.PLUGIN_OWNER ?? BASE.routerOwner;

/** Hook permissions the plugin declares: afterInitialize | beforeSwap | afterSwap. */
export const EXPECTED_HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;

/**
 * Constructor arguments of HomelanderUniV4Plugin, in order. These feed the CREATE2 init code,
 * so ANY change here moves the hook address — and with it the poolId that routes are keyed by.
 */
export function pluginConstructorArgs(owner: string) {
	return [BASE.poolManager, owner, BASE.mevxRouter, BASE.mevxExecutor, BASE.profitDistributor, PLUGIN_DYNAMIC_FEE];
}

export function pluginInitCode(creationCode: string, owner: string): string {
	const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(
		['address', 'address', 'address', 'address', 'address', 'uint24'],
		pluginConstructorArgs(owner)
	);
	return ethers.concat([creationCode, encodedArgs]);
}

/** Mines the CREATE2 salt whose resulting address carries the hook-permission bits. */
export function computeHookAddress(creationCode: string, owner: string) {
	const initCode = pluginInitCode(creationCode, owner);
	const { salt, hookAddress } = mineHookSalt(CREATE2_DEPLOYER, EXPECTED_HOOK_FLAGS, initCode);
	return { salt, hookAddress, initCode };
}

export type PoolKey = {
	currency0: string;
	currency1: string;
	fee: number;
	tickSpacing: number;
	hooks: string;
};

/** Native ETH / USDC. currency0 must be the lower address, and address(0) always is. */
export function poolKeyFor(hookAddress: string): PoolKey {
	return {
		currency0: ethers.ZeroAddress,
		currency1: BASE.usdc,
		fee: POOL_FEE,
		tickSpacing: TICK_SPACING,
		hooks: hookAddress,
	};
}

export function poolIdOf(key: PoolKey): string {
	return ethers.keccak256(
		ethers.AbiCoder.defaultAbiCoder().encode(
			['tuple(address,address,uint24,int24,address)'],
			[[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
		)
	);
}
