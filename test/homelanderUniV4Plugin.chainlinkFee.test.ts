import { ethers } from 'hardhat';
import { expect } from 'chai';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4Plugin__factory,
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
import type { HomelanderUniV4Plugin, PoolManager, PoolSwapTest } from '../typechain';
import type { PoolKeyStruct } from '../typechain/@uniswap/v4-core/src/interfaces/IPoolManager';

const DYNAMIC_FEE_FLAG = 0x800000n;
const DEFAULT_FEE_PIPS = 3000n; // 0.30% — the pre-existing static "medium" tier
const LOW_VOL_FEE_PIPS = 500n; // 0.05%
const HIGH_VOL_FEE_PIPS = 10_000n; // 1.00%
const LOW_VOL_THRESHOLD = 5n; // bps of avg per-swap price move
const HIGH_VOL_THRESHOLD = 50n;

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
	const priceFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 2000_00000000n);

	const create2Factory = await new Create2Factory__factory(deployer).deploy();
	const create2FactoryAddress = await create2Factory.getAddress();

	const dynamicFee = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;
	const hookFactory = new HomelanderUniV4Plugin__factory(deployer);
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
	const hook = hookFactory.attach(hookAddress) as HomelanderUniV4Plugin;

	// CurrencySettler.settle is an internal library call, so `address(this)` inside it is the
	// *router* (swapRouter/executorRouter/liquidityRouter), not the PoolManager — the router is
	// what actually calls `transferFrom`, so it's the router that needs the allowance.
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

	return { deployer, owner, poolManager, swapRouter, executorRouter, key, hook, priceFeed };
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

describe('HomelanderUniV4Plugin — Chainlink dynamic fee tiers', () => {
	it('falls back to the static default fee when no price feed is configured (backward-compatible)', async () => {
		const { swapRouter, poolManager, key } = await deployFixture();

		const fee = await swapAndGetAppliedFee(swapRouter, poolManager, key);
		expect(fee).to.equal(DEFAULT_FEE_PIPS);
	});

	it('tiers the swap fee off Chainlink-observed volatility, and recovers as volatility fades', async () => {
		const { owner, swapRouter, poolManager, key, hook, priceFeed } = await deployFixture();

		await hook.connect(owner).setPriceFeed(await priceFeed.getAddress());
		await hook
			.connect(owner)
			.setVolatilityFeeTiers(LOW_VOL_FEE_PIPS, HIGH_VOL_FEE_PIPS, LOW_VOL_THRESHOLD, HIGH_VOL_THRESHOLD);

		// No observations yet ⇒ volatilityScore == 0 ⇒ treated as calm ⇒ low tier.
		expect(await swapAndGetAppliedFee(swapRouter, poolManager, key)).to.equal(LOW_VOL_FEE_PIPS);

		// Steady price ⇒ stays in the low tier.
		expect(await swapAndGetAppliedFee(swapRouter, poolManager, key)).to.equal(LOW_VOL_FEE_PIPS);

		// Push a +10% price shock directly on the feed. The hook only reads the feed inside
		// afterSwap, so the very next swap's *beforeSwap* still sees the pre-shock score —
		// an honest one-swap lag, not a bug.
		await priceFeed.updateAnswer(2200_00000000n);
		expect(await swapAndGetAppliedFee(swapRouter, poolManager, key)).to.equal(LOW_VOL_FEE_PIPS);

		// That swap's afterSwap has now folded the shock into volatilityScore ⇒ next swap escalates.
		expect(await swapAndGetAppliedFee(swapRouter, poolManager, key)).to.equal(HIGH_VOL_FEE_PIPS);

		// Price holds steady post-shock ⇒ the EWMA decays each swap. After enough quiet swaps
		// it drops back below the high threshold (but not yet below the low one) ⇒ medium tier.
		let fee = 0n;
		for (let i = 0; i < 7; i++) {
			fee = await swapAndGetAppliedFee(swapRouter, poolManager, key);
		}
		expect(fee).to.equal(DEFAULT_FEE_PIPS);
	});

	it('always charges the configured executor 0 fee, regardless of the volatility tier', async () => {
		const { owner, executorRouter, poolManager, key, hook, priceFeed } = await deployFixture();

		await hook.connect(owner).setPriceFeed(await priceFeed.getAddress());
		await hook
			.connect(owner)
			.setVolatilityFeeTiers(LOW_VOL_FEE_PIPS, HIGH_VOL_FEE_PIPS, LOW_VOL_THRESHOLD, HIGH_VOL_THRESHOLD);

		await priceFeed.updateAnswer(2200_00000000n);
		await swapAndGetAppliedFee(executorRouter, poolManager, key); // fold the shock in via afterSwap

		expect(await swapAndGetAppliedFee(executorRouter, poolManager, key)).to.equal(0n);
	});

	it('rejects fee tiers above LPFeeLibrary.MAX_LP_FEE', async () => {
		const { owner, hook } = await deployFixture();

		await expect(
			hook.connect(owner).setVolatilityFeeTiers(1_000_001n, HIGH_VOL_FEE_PIPS, LOW_VOL_THRESHOLD, HIGH_VOL_THRESHOLD)
		).to.be.revertedWith('lowVolFeePips too high');
	});

	it('can be quoted through the official V4Quoter (router-compatibility check)', async () => {
		const { deployer, owner, poolManager, key, hook, priceFeed } = await deployFixture();

		await hook.connect(owner).setPriceFeed(await priceFeed.getAddress());
		await hook
			.connect(owner)
			.setVolatilityFeeTiers(LOW_VOL_FEE_PIPS, HIGH_VOL_FEE_PIPS, LOW_VOL_THRESHOLD, HIGH_VOL_THRESHOLD);

		const quoter = await new V4Quoter__factory(deployer).deploy(await poolManager.getAddress());

		// Routers/aggregators call exactly this (as a staticCall — nothing is actually committed)
		// to price a swap before submitting it. If our hook reverted or misbehaved here, the pool
		// would be unroutable from any standard v4 integration, regardless of how the tests above look.
		const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
			poolKey: key,
			zeroForOne: true,
			exactAmount: ethers.parseEther('0.001'),
			hookData: '0x',
		});

		expect(amountOut).to.be.gt(0n);
	});
});
