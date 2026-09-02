import { ethers, network } from 'hardhat';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4Plugin__factory,
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
} from '../typechain';
import type { HomelanderUniV4Plugin, HomelanderUniV4PluginChainlinkPmm, PoolManager, PoolSwapTest } from '../typechain';
import type { PoolKeyStruct } from '../typechain/@uniswap/v4-core/src/interfaces/IPoolManager';

// ──────────────────── Shared knobs, tuned so both hooks share the same resting fee and ceiling ────────────────────
const DYNAMIC_FEE_FLAG = 0x800000n;
const DEFAULT_FEE_PIPS = 1000n; // 0.10% resting fee for both hooks
const FEE_CEILING_PIPS = 10_000n; // 1.00% shared ceiling for both hooks

// EWMA-volatility hook (HomelanderUniV4Plugin)
const LOW_VOL_FEE_PIPS = 200n; // 0.02%
const HIGH_VOL_FEE_PIPS = FEE_CEILING_PIPS;
const LOW_VOL_THRESHOLD = 5n; // bps of avg per-swap price move
const HIGH_VOL_THRESHOLD = 50n;

// Chainlink-PMM hook (HomelanderUniV4PluginChainlinkPmm) — "live" shape matches a realistic
// production PMM config, just with maxFee brought down to the shared 1% ceiling above.
// `_directionalFee`'s penalty branch is `max(deviationBps*feePerDeviationBps,
// baseFee)`, capped at maxFee — i.e. a flat baseFee "dead zone" up to `baseFee/feePerDeviationBps`
// deviation, then a *linear ramp* up to maxFee at `maxFee/feePerDeviationBps` deviation. With
// feePerDeviationBps=100 that ramp is only 10bps→100bps wide, which is why a 1%(=100bps)-per-step
// trend pins it at the ceiling on almost every step (Scenario C). Retuned widens the ramp to
// 100bps→1000bps (10x gentler slope) so a single ~100bps move sits partway up instead of maxed out,
// while an 800bps shock (Scenario B) still climbs to a strongly elevated fee.
const PMM_LIVE = {
	feePerDeviationBps: 100n,
	neutralThresholdBps: 1n,
	maxSpotToReferenceDeviationBps: 2n,
	maxLimitToSpotDeviationBps: 500n,
	maxOracleAge: 3600n,
	observationWindow: 60n,
	minObservationAge: 1n,
};
const PMM_RETUNED = {
	feePerDeviationBps: 10n, // was 100 — 10x gentler ramp slope
	neutralThresholdBps: 2n, // was 1 — slightly wider true-neutral band
	maxSpotToReferenceDeviationBps: 5n, // was 2 — less twitchy guard on ordinary drift
	maxLimitToSpotDeviationBps: 500n, // unchanged
	maxOracleAge: 3600n, // unchanged
	observationWindow: 60n, // unchanged — NOT weakening the anti-manipulation guard's timing
	minObservationAge: 1n, // unchanged
};
type PmmTuning = typeof PMM_LIVE;

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;
const SWAP_TEST_SETTINGS = { takeClaims: false, settleUsingBurn: false };
const SWAP_AMOUNT_IN = ethers.parseEther('0.001');

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[0];

async function deployCommon(deployer: Signer) {
	const poolManager = await new PoolManager__factory(deployer).deploy(deployer.address);
	const poolManagerAddress = await poolManager.getAddress();

	const swapRouter = await new PoolSwapTest__factory(deployer).deploy(poolManagerAddress);
	const liquidityRouter = await new PoolModifyLiquidityTest__factory(deployer).deploy(poolManagerAddress);

	const tokenA = await new TestERC20__factory(deployer).deploy(ethers.parseEther('1000000'));
	const tokenB = await new TestERC20__factory(deployer).deploy(ethers.parseEther('1000000'));
	const [tokenAAddress, tokenBAddress] = await Promise.all([tokenA.getAddress(), tokenB.getAddress()]);
	const [currency0, currency1] =
		tokenAAddress.toLowerCase() < tokenBAddress.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

	const mevxRouter = await new MockMevxRouter__factory(deployer).deploy();
	const executor = await new MockMevxExecutor__factory(deployer).deploy();
	const profitDistributor = await new MockProfitDistributor__factory(deployer).deploy();

	const create2Factory = await new Create2Factory__factory(deployer).deploy();

	const swapRouterAddress = await swapRouter.getAddress();
	const liquidityRouterAddress = await liquidityRouter.getAddress();
	for (const spender of [swapRouterAddress, liquidityRouterAddress]) {
		await tokenA.approve(spender, ethers.MaxUint256);
		await tokenB.approve(spender, ethers.MaxUint256);
	}

	return {
		poolManager,
		swapRouter,
		liquidityRouter,
		currency0,
		currency1,
		mevxRouter,
		executor,
		profitDistributor,
		create2Factory,
	};
}

async function deployEwmaPool(deployer: Signer, owner: Signer, common: Awaited<ReturnType<typeof deployCommon>>) {
	const { poolManager, liquidityRouter, currency0, currency1, mevxRouter, executor, profitDistributor, create2Factory } =
		common;

	const feed = await new MockV3Aggregator__factory(deployer).deploy(8, 1_00000000n);

	const dynamicFee = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;
	const hookFactory = new HomelanderUniV4Plugin__factory(deployer);
	const constructorArgs = [
		await poolManager.getAddress(),
		owner.address,
		await mevxRouter.getAddress(),
		await executor.getAddress(),
		await profitDistributor.getAddress(),
		dynamicFee,
	] as const;
	const initCode = hookFactory.bytecode + hookFactory.interface.encodeDeploy(constructorArgs).slice(2);
	const create2FactoryAddress = await create2Factory.getAddress();
	const { salt, hookAddress } = mineHookSalt(create2FactoryAddress, HOOK_FLAGS, initCode);
	await (await create2Factory.deploy(salt, initCode)).wait();
	const hook = hookFactory.attach(hookAddress) as HomelanderUniV4Plugin;

	await hook.connect(owner).setPriceFeed(await feed.getAddress());
	await hook.connect(owner).setVolatilityFeeTiers(LOW_VOL_FEE_PIPS, HIGH_VOL_FEE_PIPS, LOW_VOL_THRESHOLD, HIGH_VOL_THRESHOLD);

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

	return { hook, key, feed, executorAddress: await executor.getAddress() };
}

async function deployPmmPool(
	deployer: Signer,
	owner: Signer,
	common: Awaited<ReturnType<typeof deployCommon>>,
	tuning: PmmTuning = PMM_LIVE
) {
	const { poolManager, liquidityRouter, currency0, currency1, mevxRouter, executor, profitDistributor } = common;
	// The hook's init code is identical for every PMM pool sharing the same `common` infra (config
	// differs only via a later `setPmmConfig` call, not the constructor) — CREATE2-mining the same
	// (factory, initCode) twice would collide on the same address. A fresh factory per pool sidesteps
	// that without touching what's supposed to stay shared (tokens, PoolManager, MEVX mocks).
	const create2Factory = await new Create2Factory__factory(deployer).deploy();

	const token0UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 1_00000000n);
	const token1UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 1_00000000n);

	const dynamicFee = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;
	const hookFactory = new HomelanderUniV4PluginChainlinkPmm__factory(deployer);
	const constructorArgs = [
		await poolManager.getAddress(),
		owner.address,
		await mevxRouter.getAddress(),
		await executor.getAddress(),
		await profitDistributor.getAddress(),
		dynamicFee,
	] as const;
	const initCode = hookFactory.bytecode + hookFactory.interface.encodeDeploy(constructorArgs).slice(2);
	const create2FactoryAddress = await create2Factory.getAddress();
	const { salt, hookAddress } = mineHookSalt(create2FactoryAddress, HOOK_FLAGS, initCode);
	await (await create2Factory.deploy(salt, initCode)).wait();
	const hook = hookFactory.attach(hookAddress) as HomelanderUniV4PluginChainlinkPmm;

	await hook.connect(owner).setPmmConfig({
		token0UsdFeed: await token0UsdFeed.getAddress(),
		token1UsdFeed: await token1UsdFeed.getAddress(),
		token0FeedDecimals: 0,
		token1FeedDecimals: 0,
		baseFee: DEFAULT_FEE_PIPS,
		maxFee: FEE_CEILING_PIPS,
		feePerDeviationBps: tuning.feePerDeviationBps,
		neutralThresholdBps: tuning.neutralThresholdBps,
		maxOracleAge: tuning.maxOracleAge,
		observationWindow: tuning.observationWindow,
		minObservationAge: tuning.minObservationAge,
		maxSpotToReferenceDeviationBps: tuning.maxSpotToReferenceDeviationBps,
		maxLimitToSpotDeviationBps: tuning.maxLimitToSpotDeviationBps,
		trackedTokenIsToken0: true,
		enabled: true,
	});

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

	return { hook, key, token0UsdFeed, token1UsdFeed, executorAddress: await executor.getAddress() };
}

async function swap(
	router: PoolSwapTest,
	poolManager: PoolManager,
	key: PoolKeyStruct,
	zeroForOne: boolean,
	amountIn: bigint = SWAP_AMOUNT_IN
): Promise<{ feePips: bigint; gasUsed: bigint }> {
	const tx = await router.swap(
		key,
		{
			zeroForOne,
			amountSpecified: -amountIn,
			sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
		},
		SWAP_TEST_SETTINGS,
		'0x'
	);
	const receipt = await tx.wait();
	let feePips = -1n;
	let sqrtPriceX96 = 0n;
	for (const log of receipt!.logs) {
		try {
			const parsed = poolManager.interface.parseLog(log);
			if (parsed?.name === 'Swap') {
				feePips = parsed.args.fee as bigint;
				sqrtPriceX96 = parsed.args.sqrtPriceX96 as bigint;
			}
		} catch {
			/* not a PoolManager log */
		}
	}
	return { feePips, gasUsed: receipt!.gasUsed, sqrtPriceX96 };
}

function priceFromSqrt(sqrtPriceX96: bigint): string {
	const Q192 = 1n << 192n;
	const priceWei = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / Q192;
	return (Number(priceWei) / 1e18).toFixed(6);
}

function pct(pips: bigint): string {
	if (pips < 0n) return 'n/a';
	if (pips > 0n && pips < 100n) return `${(Number(pips) / 10_000).toFixed(4)}% (${pips}pips, MIN_OVERRIDE_FEE floor)`;
	return `${(Number(pips) / 10_000).toFixed(3)}%`;
}

function row(cols: (string | bigint)[]): string {
	return cols.map((c) => String(c)).join(' | ');
}

async function main() {
	const [deployer, owner] = await ethers.getSigners();

	console.log(`\nnetwork: ${network.name}\n`);

	// ════════════════════════════════════════════════════════════════════
	// Scenario A — calm / noisy-but-flat market
	// ════════════════════════════════════════════════════════════════════
	{
		console.log('=== Scenario A: calm market (small ± noise, alternating retail direction) ===');
		const commonA = await deployCommon(deployer);
		const ewma = await deployEwmaPool(deployer, owner, commonA);
		const pmm = await deployPmmPool(deployer, owner, commonA);

		const noiseBps = [8, -5, 6, -9, 4, -3, 7, -6, 5, -8]; // small wiggles, well under both "high" thresholds
		let ewmaTotal = 0n;
		let pmmTotal = 0n;
		console.log(row(['step', 'oracle Δbps', 'dir', 'EWMA fee', 'PMM fee']));
		for (let i = 0; i < noiseBps.length; i++) {
			const factor = 1_00000000n + (1_00000000n * BigInt(noiseBps[i])) / 10_000n;
			await ewma.feed.updateAnswer(factor);
			await pmm.token1UsdFeed.updateAnswer(factor);
			const zeroForOne = i % 2 === 0;
			const e = await swap(commonA.swapRouter, commonA.poolManager, ewma.key, zeroForOne);
			const p = await swap(commonA.swapRouter, commonA.poolManager, pmm.key, zeroForOne);
			ewmaTotal += e.feePips;
			pmmTotal += p.feePips;
			console.log(row([i, noiseBps[i], zeroForOne ? '0->1' : '1->0', pct(e.feePips), pct(p.feePips)]));
		}
		console.log(`totals: EWMA=${ewmaTotal} pips-sum   PMM=${pmmTotal} pips-sum\n`);
	}

	// ════════════════════════════════════════════════════════════════════
	// Scenario B — one-off shock, then informed-correcting vs naive-widening flow
	// ════════════════════════════════════════════════════════════════════
	{
		console.log('=== Scenario B: +8% shock, then 2 informed(correcting) + 2 naive(widening) swaps ===');
		const commonB = await deployCommon(deployer);
		const ewma = await deployEwmaPool(deployer, owner, commonB);
		const pmmLive = await deployPmmPool(deployer, owner, commonB, PMM_LIVE);
		const pmmNew = await deployPmmPool(deployer, owner, commonB, PMM_RETUNED);

		// Warm-up: 2 neutral swaps so the PMM reference EMA is mature before the shock.
		for (let i = 0; i < 2; i++) {
			await swap(commonB.swapRouter, commonB.poolManager, ewma.key, i % 2 === 0);
			await swap(commonB.swapRouter, commonB.poolManager, pmmLive.key, i % 2 === 0);
			await swap(commonB.swapRouter, commonB.poolManager, pmmNew.key, i % 2 === 0);
		}

		await ewma.feed.updateAnswer(1_08000000n);
		await pmmLive.token1UsdFeed.updateAnswer(1_08000000n);
		await pmmNew.token1UsdFeed.updateAnswer(1_08000000n); // token1 now worth 8% more per the oracle

		// trackedTokenIsToken0 = true. Buying token1 (zeroForOne = true) raises the pool's token1
		// price, i.e. moves the pool TOWARD the new, higher oracle price for token1 => the
		// oracle-informed / value-extracting side => PMM's penalty branch.
		const informedDirection = true;
		// Selling token1 back in (zeroForOne = false) pushes the pool further away from the oracle
		// => PMM's discount branch.
		const naiveDirection = false;

		console.log(row(['step', 'role', 'dir', 'EWMA fee', 'PMM-live fee', 'PMM-retuned fee']));
		let idx = 0;
		for (const [role, dir] of [
			['informed', informedDirection],
			['informed', informedDirection],
			['naive', naiveDirection],
			['naive', naiveDirection],
		] as const) {
			const e = await swap(commonB.swapRouter, commonB.poolManager, ewma.key, dir);
			const pl = await swap(commonB.swapRouter, commonB.poolManager, pmmLive.key, dir);
			const pn = await swap(commonB.swapRouter, commonB.poolManager, pmmNew.key, dir);
			console.log(row([idx++, role, dir ? '0->1' : '1->0', pct(e.feePips), pct(pl.feePips), pct(pn.feePips)]));
		}
		console.log('');
	}

	// ════════════════════════════════════════════════════════════════════
	// Scenario C — sustained one-directional trend, informed flow throughout
	// ════════════════════════════════════════════════════════════════════
	{
		console.log('=== Scenario C: sustained +1%/step trend, every swap on the informed/correcting side ===');
		const commonC = await deployCommon(deployer);
		const ewma = await deployEwmaPool(deployer, owner, commonC);
		const pmmLive = await deployPmmPool(deployer, owner, commonC, PMM_LIVE);
		const pmmNew = await deployPmmPool(deployer, owner, commonC, PMM_RETUNED);

		for (let i = 0; i < 2; i++) {
			await swap(commonC.swapRouter, commonC.poolManager, ewma.key, true);
			await swap(commonC.swapRouter, commonC.poolManager, pmmLive.key, true);
			await swap(commonC.swapRouter, commonC.poolManager, pmmNew.key, true);
		}

		let price = 1_00000000n;
		let ewmaTotal = 0n;
		let pmmLiveTotal = 0n;
		let pmmNewTotal = 0n;
		console.log(row(['step', 'oracle', 'EWMA fee', 'PMM-live fee', 'PMM-retuned fee']));
		for (let i = 0; i < 8; i++) {
			price = (price * 101n) / 100n;
			await ewma.feed.updateAnswer(price);
			await pmmLive.token1UsdFeed.updateAnswer(price);
			await pmmNew.token1UsdFeed.updateAnswer(price);
			const e = await swap(commonC.swapRouter, commonC.poolManager, ewma.key, true);
			const pl = await swap(commonC.swapRouter, commonC.poolManager, pmmLive.key, true);
			const pn = await swap(commonC.swapRouter, commonC.poolManager, pmmNew.key, true);
			ewmaTotal += e.feePips;
			pmmLiveTotal += pl.feePips;
			pmmNewTotal += pn.feePips;
			console.log(row([i, price.toString(), pct(e.feePips), pct(pl.feePips), pct(pn.feePips)]));
		}
		console.log(
			`avg fee across trend: EWMA=${pct(ewmaTotal / 8n)}   PMM-live=${pct(pmmLiveTotal / 8n)}   PMM-retuned=${pct(pmmNewTotal / 8n)}\n`
		);
	}

	// ════════════════════════════════════════════════════════════════════
	// Scenario D — discount-gaming attempt (PMM's reference-safety guard)
	// ════════════════════════════════════════════════════════════════════
	{
		console.log('=== Scenario D: reference-safety guard — same oracle gap, does the discount clear the guard? ===');
		const commonD = await deployCommon(deployer);
		const pmm = await deployPmmPool(deployer, owner, commonD);

		for (let i = 0; i < 2; i++) {
			await swap(commonD.swapRouter, commonD.poolManager, pmm.key, true, 1n);
		}

		await pmm.token1UsdFeed.updateAnswer(1_08000000n); // same +8% gap as Scenario B

		// Unlike Scenario B's tiny 0.001-token probes (which barely move spot, so the reference EMA
		// trivially stays "safe"), this is a real-sized informed trade — it both pays the penalty fee
		// itself *and* drags spot away from wherever the reference currently sits, which is exactly
		// the situation `_isPoolReferenceSafe` exists to catch.
		const bigInformed = await swap(commonD.swapRouter, commonD.poolManager, pmm.key, true, ethers.parseEther('0.03'));
		console.log(
			`large informed swap (0.03 tokens) fee: ${pct(bigInformed.feePips)}, spot now: ${priceFromSqrt(bigInformed.sqrtPriceX96)}` +
				` [reference=${await pmm.hook.referencePoolPriceWei()}, pending=${await pmm.hook.pendingPoolPriceWei()}]`
		);

		const immediateDiscount = await swap(commonD.swapRouter, commonD.poolManager, pmm.key, false, 1000n);
		console.log(
			`next-block naive/discount-direction fee, reference not yet caught up: ${pct(immediateDiscount.feePips)}` +
				` (baseFee=${DEFAULT_FEE_PIPS} pips ⇒ guard is refusing the discount)` +
				` [reference=${await pmm.hook.referencePoolPriceWei()}, pending=${await pmm.hook.pendingPoolPriceWei()}, obsCount=${await pmm.hook.observationCount()}]`
		);

		// The reference EMA's time constant is `observationWindow` (60s here, 1 block/step on this
		// local network) — each promotion only closes ~elapsed/window of the remaining gap, so
		// catching up to within the 2bp guard band takes on the order of a few hundred blocks, not a
		// handful. Real time, not a test artifact: 60s is a realistic production window size.
		const MATURATION_STEPS = 400;
		for (let i = 0; i < MATURATION_STEPS; i++) {
			await swap(commonD.swapRouter, commonD.poolManager, pmm.key, true, 1n);
		}
		console.log(
			`after ${MATURATION_STEPS} blocks: reference=${await pmm.hook.referencePoolPriceWei()}, pending=${await pmm.hook.pendingPoolPriceWei()}`
		);
		const maturedDiscount = await swap(commonD.swapRouter, commonD.poolManager, pmm.key, false, 1000n);
		console.log(`same direction, once the reference has caught up: ${pct(maturedDiscount.feePips)}\n`);
	}

	// ════════════════════════════════════════════════════════════════════
	// Scenario E — oracle goes stale (feed stops updating, no revert)
	// ════════════════════════════════════════════════════════════════════
	{
		console.log('=== Scenario E: oracle stalls (stops updating) past maxOracleAge, market has actually moved ===');
		const commonE = await deployCommon(deployer);
		const ewma = await deployEwmaPool(deployer, owner, commonE);
		const pmm = await deployPmmPool(deployer, owner, commonE);

		// One real shock so both hooks are away from their "just deployed" baseline...
		await ewma.feed.updateAnswer(1_15000000n);
		await pmm.token1UsdFeed.updateAnswer(1_15000000n);
		await swap(commonE.swapRouter, commonE.poolManager, ewma.key, true);
		await swap(commonE.swapRouter, commonE.poolManager, pmm.key, true);
		// ...then the feed stalls right here (no more updateAnswer calls) while time keeps moving.
		await network.provider.send('evm_increaseTime', [Number(PMM_LIVE.maxOracleAge) + 60]);
		await network.provider.send('evm_mine');

		const e = await swap(commonE.swapRouter, commonE.poolManager, ewma.key, true);
		const p = await swap(commonE.swapRouter, commonE.poolManager, pmm.key, true);
		console.log(`EWMA fee once feed is stale (no explicit staleness check ⇒ reads the frozen answer as if live): ${pct(e.feePips)}`);
		console.log(`PMM fee once feed exceeds maxOracleAge (explicit check ⇒ falls back to baseFee):              ${pct(p.feePips)}\n`);
	}

	// ════════════════════════════════════════════════════════════════════
	// Scenario F — gas overhead in the steady state
	// ════════════════════════════════════════════════════════════════════
	{
		console.log('=== Scenario F: gas per swap, steady state (no shock, both PMM feeds/EWMA feed static) ===');
		const commonF = await deployCommon(deployer);
		const ewma = await deployEwmaPool(deployer, owner, commonF);
		const pmm = await deployPmmPool(deployer, owner, commonF);

		// Warm up storage slots (cold->warm SSTORE/SLOAD skews the first swap) before measuring.
		await swap(commonF.swapRouter, commonF.poolManager, ewma.key, true);
		await swap(commonF.swapRouter, commonF.poolManager, pmm.key, true);

		const e = await swap(commonF.swapRouter, commonF.poolManager, ewma.key, true);
		const p = await swap(commonF.swapRouter, commonF.poolManager, pmm.key, true);
		console.log(`EWMA swap gas: ${e.gasUsed}`);
		console.log(`PMM  swap gas: ${p.gasUsed}`);
		console.log(`PMM overhead:  +${p.gasUsed - e.gasUsed} gas (+${(Number(p.gasUsed - e.gasUsed) * 100 / Number(e.gasUsed)).toFixed(1)}%)\n`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
