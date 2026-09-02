import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4PluginChainlinkPmm__factory,
	DemoMevxRouter__factory,
	DemoMevxExecutor__factory,
	PoolManager__factory,
} from '../typechain';

// Second attempt at a clean-slate showcase pool: the first attempt (demoHook
// 0x0AeBB87b8f536fffEcd7cCff263a3F25c4b190c0) turned out to already be initialized — by an
// earlier verifyWizardFlow.ts run — at MIN_SQRT_PRICE (tick -887272), a degenerate test price,
// not the realistic ~2500 USDC/WETH bootstrap. That broke the arb-spread math (astronomically
// large spreadBps) and can't be fixed since a pool can only be initialized once. This deploys a
// genuinely fresh hook (distinct constructor seed so CREATE2 doesn't collide with any prior
// deploy), reuses the SAME already-deployed, correctly-configured price feeds and the shared
// executor, and — critically — verifies the real on-chain price immediately after initialize
// before doing anything else.
const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));

const POOL_MANAGER: string = existing.poolManager;
const WETH: string = existing.weth;
const USDC: string = existing.usdc;
const POOL_MODIFY_LIQUIDITY_TEST: string = existing.poolModifyLiquidityTest;
const DEMO_MEVX_ROUTER: string = existing.demoMevxRouter;
const DEMO_MEVX_EXECUTOR: string = existing.demoMevxExecutor;
const DEMO_PROFIT_DISTRIBUTOR: string = existing.demoProfitDistributor;
// Reuse the feeds already deployed (and already correctly answering $1.00 / $2500.00) for the
// first (broken-price) attempt — no need to redeploy them, only the hook+pool were bad.
const TOKEN0_USD_FEED = existing.demoToken0UsdFeed;
const TOKEN1_USD_FEED = existing.demoToken1UsdFeed;
const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

const DYNAMIC_FEE_FLAG = 0x800000n;
const DEFAULT_FEE_PIPS = 3000n;
const MAX_FEE_PIPS = 10_000n;
const FEE_PER_DEVIATION_BPS = 10n;
const NEUTRAL_THRESHOLD_BPS = 5n;
const MAX_SPOT_TO_REFERENCE_DEVIATION_BPS = 50n;
const MAX_LIMIT_TO_SPOT_DEVIATION_BPS = 500n;
const MAX_ORACLE_AGE = 2_592_000n;
const OBSERVATION_WINDOW = 60n;
const MIN_OBSERVATION_AGE = 1n;

const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;
const SQRT_PRICE_USDC_WETH = 20000n * 2n ** 96n; // ~2500 USDC/WETH — matches the feeds' $1.00/$2500.00

interface PoolKeyLike {
	currency0: string;
	currency1: string;
	fee: bigint;
	tickSpacing: number;
	hooks: string;
}

async function log(label: string, value: unknown) {
	console.log(`${label.padEnd(28)} ${value}`);
}

async function main() {
	const deployer = (await ethers.getSigners())[0];
	await log('Deployer', deployer.address);

	// ──────────────────── 1. Mine + deploy a genuinely fresh PMM hook ────────────────────
	// Different constructor seed (baseFee 3333, immediately overwritten by setPmmConfig below)
	// than every prior deploy this session, purely so CREATE2 lands on a brand-new address.
	const dynamicFee = DYNAMIC_FEE_FLAG | 3333n;
	const hookFactory = new HomelanderUniV4PluginChainlinkPmm__factory(deployer);
	const constructorArgs = [
		POOL_MANAGER,
		deployer.address,
		DEMO_MEVX_ROUTER,
		DEMO_MEVX_EXECUTOR,
		DEMO_PROFIT_DISTRIBUTOR,
		dynamicFee,
	] as const;
	const initCode = (hookFactory.bytecode + hookFactory.interface.encodeDeploy(constructorArgs).slice(2)) as `0x${string}`;

	const { salt, hookAddress } = mineHookSalt(CREATE2_FACTORY, HOOK_FLAGS, initCode);
	await log('Mined hook address', hookAddress);

	const existingCode = await ethers.provider.getCode(hookAddress);
	if (existingCode !== '0x') {
		throw new Error(`Address collision again — ${hookAddress} already has code`);
	}

	const deployCalldata = (salt + initCode.slice(2)) as `0x${string}`;
	await (await deployer.sendTransaction({ to: CREATE2_FACTORY, data: deployCalldata, gas: 4_000_000n })).wait();
	const codeAtHook = await ethers.provider.getCode(hookAddress);
	if (codeAtHook === '0x') throw new Error('Hook deployment failed');
	const hook = hookFactory.attach(hookAddress) as ReturnType<typeof hookFactory.attach> & {
		setPmmConfig: (...args: any[]) => Promise<any>;
	};
	await log('Fresh PMM hook deployed', hookAddress);

	// ──────────────────── 2. Wire the PMM config (reusing the existing feeds) ────────────────────
	const [currency0, currency1] = WETH.toLowerCase() < USDC.toLowerCase() ? [WETH, USDC] : [USDC, WETH];
	const trackedTokenIsToken0 = currency0.toLowerCase() === WETH.toLowerCase();

	await (
		await hook.setPmmConfig({
			token0UsdFeed: TOKEN0_USD_FEED,
			token1UsdFeed: TOKEN1_USD_FEED,
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
			trackedTokenIsToken0,
			enabled: true,
		})
	).wait();
	await log('PMM config set', 'done');

	// ──────────────────── 3. Initialize the fresh Pool A at the REAL bootstrap price ────────────────────
	const keyA: PoolKeyLike = { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: hookAddress };
	const poolManager = PoolManager__factory.connect(POOL_MANAGER, deployer);

	const initTxA = await poolManager.initialize(keyA, SQRT_PRICE_USDC_WETH);
	const initReceiptA = await initTxA.wait();
	const poolIdA = extractPoolId(poolManager, initReceiptA!);
	await log('Fresh Pool A poolId', poolIdA);

	// Verify the real on-chain price BEFORE doing anything else — this is exactly the check
	// skipped last time, which let a degenerate MIN_SQRT_PRICE pool slip through unnoticed.
	const slot0 = await readSlot0(poolManager, poolIdA);
	await log('Verified sqrtPriceX96', slot0.sqrtPriceX96.toString());
	await log('Verified tick', slot0.tick.toString());
	const expectedRatio = Number(slot0.sqrtPriceX96) / Number(SQRT_PRICE_USDC_WETH);
	if (Math.abs(expectedRatio - 1) > 0.001) {
		throw new Error(
			`Bootstrap price mismatch! sqrtPriceX96=${slot0.sqrtPriceX96} vs expected ${SQRT_PRICE_USDC_WETH} — refusing to continue.`
		);
	}
	await log('Price check', 'PASSED — matches ~2500 USDC/WETH bootstrap');

	// ──────────────────── 4. Register Pool B as this pool's reference ────────────────────
	const router = DemoMevxRouter__factory.connect(DEMO_MEVX_ROUTER, deployer);
	const vanillaKeyB: PoolKeyLike = { currency0, currency1, fee: 1337n, tickSpacing: 13, hooks: ethers.ZeroAddress };
	await (await router.setReferencePool(poolIdA, vanillaKeyB)).wait();
	await log("Pool B registered as this pool's reference", 'done');

	// ──────────────────── 5. Authorize this hook on the shared executor ────────────────────
	const executor = DemoMevxExecutor__factory.connect(DEMO_MEVX_EXECUTOR, deployer);
	await (await executor.setAuthorizedCaller(hookAddress, true)).wait();
	await log('Executor authorized this hook', 'done');

	// ──────────────────── 6. Add liquidity around the real current price ────────────────────
	const ERC20_ABI = ['function approve(address,uint256) returns (bool)'];
	const weth = new ethers.Contract(WETH, ERC20_ABI, deployer);
	const usdc = new ethers.Contract(USDC, ERC20_ABI, deployer);
	await (await weth.approve(POOL_MODIFY_LIQUIDITY_TEST, ethers.MaxUint256)).wait();
	await (await usdc.approve(POOL_MODIFY_LIQUIDITY_TEST, ethers.MaxUint256)).wait();

	const liquidityRouter = await ethers.getContractAt('PoolModifyLiquidityTest', POOL_MODIFY_LIQUIDITY_TEST, deployer);
	const tickSpacing = Number(keyA.tickSpacing);
	const centerTick = Math.floor(Number(slot0.tick) / tickSpacing) * tickSpacing;
	await (
		await liquidityRouter.modifyLiquidity(
			keyA,
			{
				tickLower: centerTick - 20 * tickSpacing,
				tickUpper: centerTick + 20 * tickSpacing,
				liquidityDelta: ethers.parseUnits('2000000000000', 0),
				salt: ethers.ZeroHash,
			},
			'0x'
		)
	).wait();
	await log('Liquidity added around real price', 'done');

	// ──────────────────── Write results — replaces the broken-price attempt ────────────────────
	const result = {
		...existing,
		demoHookKind: 'pmm',
		demoHook: hookAddress,
		demoToken0UsdFeed: TOKEN0_USD_FEED,
		demoToken1UsdFeed: TOKEN1_USD_FEED,
		poolIdA,
	};
	const outPath = path.join(__dirname, '..', 'deployments-sepolia.json');
	fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
	console.log('\nWrote deployment addresses to', outPath);
	console.log(JSON.stringify(result, null, 2));
}

async function readSlot0(
	poolManager: ReturnType<typeof PoolManager__factory.connect>,
	poolId: string
): Promise<{ sqrtPriceX96: bigint; tick: bigint }> {
	const POOLS_SLOT = 6n;
	const stateSlot = ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [poolId, POOLS_SLOT]));
	const data = BigInt(await poolManager.getFunction('extsload(bytes32)').staticCall(stateSlot));
	const sqrtPriceX96 = data & ((1n << 160n) - 1n);
	let tick = (data >> 160n) & ((1n << 24n) - 1n);
	if (tick & (1n << 23n)) tick -= 1n << 24n;
	return { sqrtPriceX96, tick };
}

function extractPoolId(poolManager: ReturnType<typeof PoolManager__factory.connect>, receipt: any): string {
	for (const logEntry of receipt.logs) {
		try {
			const parsed = poolManager.interface.parseLog(logEntry);
			if (parsed?.name === 'Initialize') return parsed.args.id as string;
		} catch {
			// not a PoolManager log
		}
	}
	throw new Error('Initialize event not found in receipt');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
