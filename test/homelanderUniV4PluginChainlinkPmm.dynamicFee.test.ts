import { ethers } from 'hardhat';
import { expect } from 'chai';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4PluginChainlinkPmm__factory,
	PoolManager__factory,
	PoolSwapTest__factory,
	PoolModifyLiquidityTest__factory,
	TestERC20__factory,
	MockV3Aggregator__factory,
	MockMevxRouter__factory,
	MockMevxExecutor__factory,
	MockProfitDistributor__factory,
	Create2Factory__factory,
	V4Quoter__factory,
} from '../typechain';
import type { HomelanderUniV4PluginChainlinkPmm, PoolManager, PoolSwapTest } from '../typechain';
import type { PoolKeyStruct } from '../typechain/@uniswap/v4-core/src/interfaces/IPoolManager';

const DYNAMIC_FEE_FLAG = 0x800000n;
const DEFAULT_FEE_PIPS = 3000n; // 0.30% — the fallback fee while the PMM engine is disabled

// A realistic PMM config (baseFee 1000 = 0.1%, maxFee 5%, neutral band ~0.01%), tightened so a
// single 10% price shock (as used below) clears both the neutral band and the reference-safety
// band inside this test.
const BASE_FEE_PIPS = 1000n; // 0.10%
const MAX_FEE_PIPS = 50_000n; // 5.00%
const FEE_PER_DEVIATION_BPS = 100n;
const NEUTRAL_THRESHOLD_BPS = 1n;
const MAX_SPOT_TO_REFERENCE_DEVIATION_BPS = 2n;
const MAX_LIMIT_TO_SPOT_DEVIATION_BPS = 500n;
const MAX_ORACLE_AGE = 3600n;
const OBSERVATION_WINDOW = 60n;
const MIN_OBSERVATION_AGE = 1n;

const MIN_SQRT_PRICE = 4295128739n;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n; // 2^96, i.e. price = 1

const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;

const SWAP_TEST_SETTINGS = { takeClaims: false, settleUsingBurn: false };
const SWAP_AMOUNT = -ethers.parseEther('0.001'); // small, so repeated swaps don't run out of tick range

async function deployFixture() {
	const [deployer, owner] = await ethers.getSigners();

	const poolManager = await new PoolManager__factory(deployer).deploy(deployer.address);
	const poolManagerAddress = await poolManager.getAddress();

	const swapRouter = await new PoolSwapTest__factory(deployer).deploy(poolManagerAddress);
	const executorRouter = await new PoolSwapTest__factory(deployer).deploy(poolManagerAddress);
	const liquidityRouter = await new PoolModifyLiquidityTest__factory(deployer).deploy(poolManagerAddress);

	const tokenA = await new TestERC20__factory(deployer).deploy(ethers.parseEther('1000000'));
	const tokenB = await new TestERC20__factory(deployer).deploy(ethers.parseEther('1000000'));
	const [tokenAAddress, tokenBAddress] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);
	const [currency0, currency1] =
		tokenAAddress.toLowerCase() < tokenBAddress.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

	const mevxRouter = await new MockMevxRouter__factory(deployer).deploy();
	const executorRouterAddress = await executorRouter.getAddress();
	const profitDistributor = await new MockProfitDistributor__factory(deployer).deploy();
	// Deployed but unused by these tests: MockMevxRouter.initialArbCheck always reports "no
	// opportunity", so the executor's executeRoute is never actually invoked.
	await new MockMevxExecutor__factory(deployer).deploy();

	// Both feeds start at $1 (18-decimal token, both legs priced the same) so the pool's 1:1 spot
	// price starts exactly on the oracle ratio — a clean "neutral" baseline.
	const token0UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 1_00000000n);
	const token1UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 1_00000000n);

	const create2Factory = await new Create2Factory__factory(deployer).deploy();
	const create2FactoryAddress = await create2Factory.getAddress();

	const dynamicFee = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;
	const hookFactory = new HomelanderUniV4PluginChainlinkPmm__factory(deployer);
	const constructorArgs = [
		poolManagerAddress,
		owner.address,
		await mevxRouter.getAddress(),
		executorRouterAddress, // the "executor" swap path == executorRouter's own address
		await profitDistributor.getAddress(),
		dynamicFee,
	] as const;
	const initCode = hookFactory.bytecode + hookFactory.interface.encodeDeploy(constructorArgs).slice(2);

	const { salt, hookAddress } = mineHookSalt(create2FactoryAddress, HOOK_FLAGS, initCode);
	await (await create2Factory.deploy(salt, initCode)).wait();
	const hook = hookFactory.attach(hookAddress) as HomelanderUniV4PluginChainlinkPmm;

	const swapRouterAddress = await swapRouter.getAddress();
	const liquidityRouterAddress = await liquidityRouter.getAddress();
	for (const spender of [swapRouterAddress, executorRouterAddress, liquidityRouterAddress]) {
		await tokenA.approve(spender, ethers.MaxUint256);
		await tokenB.approve(spender, ethers.MaxUint256);
	}

	const key: PoolKeyStruct = {
		currency0: await currency0.getAddress(),
		currency1: await currency1.getAddress(),
		fee: DYNAMIC_FEE_FLAG,
		tickSpacing: 60,
		hooks: hookAddress,
	};

	await poolManager.initialize(key, SQRT_PRICE_1_1);
	await liquidityRouter.modifyLiquidity(
		key,
		{ tickLower: -600, tickUpper: 600, liquidityDelta: ethers.parseEther('10'), salt: ethers.ZeroHash },
		'0x'
	);

	return {
		deployer,
		owner,
		poolManager,
		swapRouter,
		executorRouter,
		key,
		hook,
		token0UsdFeed,
		token1UsdFeed,
	};
}

async function enablePmm(
	hook: HomelanderUniV4PluginChainlinkPmm,
	owner: Awaited<ReturnType<typeof ethers.getSigners>>[0],
	token0UsdFeed: string,
	token1UsdFeed: string
) {
	await hook.connect(owner).setPmmConfig({
		token0UsdFeed,
		token1UsdFeed,
		token0FeedDecimals: 0, // overwritten by the contract from feed.decimals()
		token1FeedDecimals: 0,
		baseFee: BASE_FEE_PIPS,
		maxFee: MAX_FEE_PIPS,
		feePerDeviationBps: FEE_PER_DEVIATION_BPS,
		neutralThresholdBps: NEUTRAL_THRESHOLD_BPS,
		maxOracleAge: MAX_ORACLE_AGE,
		observationWindow: OBSERVATION_WINDOW,
		minObservationAge: MIN_OBSERVATION_AGE,
		maxSpotToReferenceDeviationBps: MAX_SPOT_TO_REFERENCE_DEVIATION_BPS,
		maxLimitToSpotDeviationBps: MAX_LIMIT_TO_SPOT_DEVIATION_BPS,
		trackedTokenIsToken0: true,
		enabled: true,
	});
}

/** Executes one small zeroForOne swap through `router` and returns the LP fee (pips) the
 * PoolManager actually applied, read straight off the `Swap` event. */
async function swapAndGetAppliedFee(router: PoolSwapTest, poolManager: PoolManager, key: PoolKeyStruct): Promise<bigint> {
	const tx = await router.swap(
		key,
		{ zeroForOne: true, amountSpecified: SWAP_AMOUNT, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n },
		SWAP_TEST_SETTINGS,
		'0x'
	);
	const receipt = await tx.wait();
	for (const log of receipt!.logs) {
		try {
			const parsed = poolManager.interface.parseLog(log);
			if (parsed?.name === 'Swap') {
				return parsed.args.fee as bigint;
			}
		} catch {
			// not a PoolManager-emitted log (e.g. an ERC20 Transfer) — skip
		}
	}
	throw new Error('Swap event not found in transaction receipt');
}

describe('HomelanderUniV4PluginChainlinkPmm — Chainlink oracle-deviation dynamic fee', () => {
	it('falls back to the static default fee when the PMM engine is not enabled', async () => {
		const { swapRouter, poolManager, key } = await deployFixture();

		const fee = await swapAndGetAppliedFee(swapRouter, poolManager, key);
		expect(fee).to.equal(DEFAULT_FEE_PIPS);
	});

	it('always charges the configured executor 0 fee, even with the PMM engine enabled', async () => {
		const { owner, executorRouter, poolManager, key, hook, token0UsdFeed, token1UsdFeed } = await deployFixture();

		await enablePmm(hook, owner, await token0UsdFeed.getAddress(), await token1UsdFeed.getAddress());

		expect(await swapAndGetAppliedFee(executorRouter, poolManager, key)).to.equal(0n);
	});

	it('charges baseFee while the pool tracks the oracle 1:1', async () => {
		const { owner, swapRouter, poolManager, key, hook, token0UsdFeed, token1UsdFeed } = await deployFixture();

		await enablePmm(hook, owner, await token0UsdFeed.getAddress(), await token1UsdFeed.getAddress());

		expect(await swapAndGetAppliedFee(swapRouter, poolManager, key)).to.equal(BASE_FEE_PIPS);
		expect(await swapAndGetAppliedFee(swapRouter, poolManager, key)).to.equal(BASE_FEE_PIPS);
	});

	it('penalizes a swap that would push the pool further from the oracle, and matures the reference guard', async () => {
		const { owner, swapRouter, poolManager, key, hook, token0UsdFeed, token1UsdFeed } = await deployFixture();

		await enablePmm(hook, owner, await token0UsdFeed.getAddress(), await token1UsdFeed.getAddress());

		// A couple of neutral swaps to mature the EMA reference (MIN_MATURE_OBSERVATIONS == 2) before
		// the shock — otherwise `_isPoolReferenceSafe` is false and every fee is floored at baseFee
		// anyway, which would mask the effect we're testing.
		await swapAndGetAppliedFee(swapRouter, poolManager, key);
		await swapAndGetAppliedFee(swapRouter, poolManager, key);

		// Move token1's USD price up 10% (token1 now worth more ⇒ pool underprices token1 relative to
		// the oracle). `_beforeSwap` reads the feed live (unlike the EWMA-volatility sibling hook, it
		// does not wait for the next afterSwap), so the very next swap already sees the shock.
		await token1UsdFeed.updateAnswer(1_10000000n);

		// zeroForOne (token0 -> token1) *buys* token1 — with `trackedTokenIsToken0 = true` that's the
		// "not tracked bought" / oracle-below-pool-for-token1 case, i.e. the swap pulls the pool price
		// further from the now-higher oracle price for token1 ⇒ penalty branch.
		const fee = await swapAndGetAppliedFee(swapRouter, poolManager, key);
		expect(fee).to.be.gt(BASE_FEE_PIPS);
		expect(fee).to.be.lte(MAX_FEE_PIPS);
	});

	it('rejects a maxFee at or above LPFeeLibrary.MAX_LP_FEE', async () => {
		const { owner, hook, token0UsdFeed, token1UsdFeed } = await deployFixture();

		await expect(
			hook.connect(owner).setPmmConfig({
				token0UsdFeed: await token0UsdFeed.getAddress(),
				token1UsdFeed: await token1UsdFeed.getAddress(),
				token0FeedDecimals: 0,
				token1FeedDecimals: 0,
				baseFee: BASE_FEE_PIPS,
				maxFee: 1_000_000n,
				feePerDeviationBps: FEE_PER_DEVIATION_BPS,
				neutralThresholdBps: NEUTRAL_THRESHOLD_BPS,
				maxOracleAge: MAX_ORACLE_AGE,
				observationWindow: OBSERVATION_WINDOW,
				minObservationAge: MIN_OBSERVATION_AGE,
				maxSpotToReferenceDeviationBps: MAX_SPOT_TO_REFERENCE_DEVIATION_BPS,
				maxLimitToSpotDeviationBps: MAX_LIMIT_TO_SPOT_DEVIATION_BPS,
				trackedTokenIsToken0: true,
				enabled: true,
			})
		).to.be.revertedWith('maxFee too high');
	});

	it('can be quoted through the official V4Quoter (router-compatibility check)', async () => {
		const { deployer, owner, poolManager, key, hook, token0UsdFeed, token1UsdFeed } = await deployFixture();

		await enablePmm(hook, owner, await token0UsdFeed.getAddress(), await token1UsdFeed.getAddress());

		const quoter = await new V4Quoter__factory(deployer).deploy(await poolManager.getAddress());

		const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
			poolKey: key,
			zeroForOne: true,
			exactAmount: ethers.parseEther('0.001'),
			hookData: '0x',
		});

		expect(amountOut).to.be.gt(0n);
	});
});
