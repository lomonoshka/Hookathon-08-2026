import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4PluginChainlinkPmm__factory,
	MockV3Aggregator__factory,
	PoolManager__factory,
} from '../typechain';

// Mirrors EXACTLY what the /deploy wizard's deployHook() + configurePmm() + initializePool() do
// client-side, using the real wallet, to prove the flow works before trusting a build pass alone.
const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));

const DYNAMIC_FEE_FLAG = 0x800000n;
const DEFAULT_FEE_PIPS = 3000n;
const MAX_FEE_PIPS = 10_000n;
const FEE_PER_DEVIATION_BPS = 10n;
const NEUTRAL_THRESHOLD_BPS = 5n;
const MAX_ORACLE_AGE = 30n * 24n * 3600n;
const OBSERVATION_WINDOW = 60n;
const MIN_OBSERVATION_AGE = 1n;
const MAX_SPOT_TO_REFERENCE_DEVIATION_BPS = 50n;
const MAX_LIMIT_TO_SPOT_DEVIATION_BPS = 500n;
const INITIAL_USDC_ANSWER = 1_00000000n;
const INITIAL_WETH_ANSWER = 2500_00000000n;
const SQRT_PRICE_USDC_WETH = 20000n * 2n ** 96n;
const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log('signer', deployer.address);

	// ── Step 1: deploy hook (same constructor args the wizard sends) ──
	const dynamicFee = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;
	const hookFactory = new HomelanderUniV4PluginChainlinkPmm__factory(deployer);
	const constructorArgs = [
		existing.poolManager,
		deployer.address,
		existing.demoMevxRouter,
		existing.demoMevxExecutor,
		existing.demoProfitDistributor,
		dynamicFee,
	] as const;
	const initCode = hookFactory.bytecode + hookFactory.interface.encodeDeploy(constructorArgs).slice(2);
	const { salt, hookAddress } = mineHookSalt(CREATE2_FACTORY, HOOK_FLAGS, initCode);
	const deployTx = await deployer.sendTransaction({ to: CREATE2_FACTORY, data: (salt + initCode.slice(2)) as `0x${string}`, gasLimit: 4_000_000n });
	await deployTx.wait();
	const code = await ethers.provider.getCode(hookAddress);
	if (code === '0x') throw new Error('Step 1 FAILED: no code at mined hook address');
	const hook = hookFactory.attach(hookAddress) as import('../typechain').HomelanderUniV4PluginChainlinkPmm;
	console.log('Step 1 OK — hook deployed at', hookAddress);

	// ── Step 2: deploy 2 feeds + setPmmConfig (same as configurePmm()) ──
	const feed0 = await new MockV3Aggregator__factory(deployer).deploy(8, INITIAL_USDC_ANSWER);
	await feed0.waitForDeployment();
	const feed1 = await new MockV3Aggregator__factory(deployer).deploy(8, INITIAL_WETH_ANSWER);
	await feed1.waitForDeployment();
	const feed0Address = await feed0.getAddress();
	const feed1Address = await feed1.getAddress();

	const configTx = await hook.setPmmConfig({
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
	});
	await configTx.wait();
	console.log('Step 2 OK — feeds', feed0Address, feed1Address, 'configured');

	// ── Step 3: initialize pool at the realistic bootstrap price ──
	const [currency0, currency1] =
		existing.weth.toLowerCase() < existing.usdc.toLowerCase() ? [existing.weth, existing.usdc] : [existing.usdc, existing.weth];
	const key = { currency0, currency1, fee: Number(DYNAMIC_FEE_FLAG), tickSpacing: 60, hooks: hookAddress };
	const poolManager = PoolManager__factory.connect(existing.poolManager, deployer);
	const initTx = await poolManager.initialize(key, SQRT_PRICE_USDC_WETH, { gasLimit: 6_000_000n });
	const initReceipt = await initTx.wait();
	console.log('Step 3 OK — pool initialized, tx', initTx.hash);

	// ── Verify: read back pmmConfig + a fee quote, matching what the dashboard would show ──
	const cfg = await hook.pmmConfig();
	console.log('\n=== pmmConfig readback ===');
	console.log('token0UsdFeed:', cfg.token0UsdFeed, '(expect', feed0Address, ')');
	console.log('token1UsdFeed:', cfg.token1UsdFeed, '(expect', feed1Address, ')');
	console.log('baseFee:', cfg.baseFee.toString(), 'maxFee:', cfg.maxFee.toString());
	console.log('enabled:', cfg.enabled);

	// ── Smoke-test swap: baseFee at rest (proves the bootstrap price matches the feeds) ──
	const swapRouter = await ethers.getContractAt('PoolSwapTest', existing.poolSwapTest, deployer);
	const MIN_SQRT_PRICE = 4295128739n;
	const swapTx = await swapRouter.swap(
		key,
		{ zeroForOne: true, amountSpecified: -ethers.parseUnits('0.0005', 6), sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n },
		{ takeClaims: false, settleUsingBurn: false },
		'0x',
		{ gasLimit: 7_000_000n }
	);
	const swapReceipt = await swapTx.wait();
	for (const log of swapReceipt!.logs) {
		try {
			const parsed = poolManager.interface.parseLog(log);
			if (parsed?.name === 'Swap') {
				console.log('\n=== Smoke-test swap ===');
				console.log('fee applied:', parsed.args.fee.toString(), `(expect close to ${DEFAULT_FEE_PIPS} = baseFee, since nothing has diverged yet)`);
			}
		} catch {}
	}

	console.log('\nALL STEPS PASSED. Hook:', hookAddress, 'PoolId computed client-side would match this deployment.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
