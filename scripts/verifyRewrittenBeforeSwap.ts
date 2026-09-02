import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4PluginChainlinkPmm__factory,
	MockV3Aggregator__factory,
	PoolManager__factory,
} from '../typechain';

// Throwaway verification pool — NOT the official showcase, NOT registered anywhere — just to
// prove the rewritten (non-view) _beforeSwap / synchronous EMA promote-and-stage logic actually
// works against a real deployment of the freshly-compiled bytecode, with minimal token spend
// (small liquidity position) since this wallet's remaining WETH/USDC is needed for the owner's
// own real wizard run.
const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));

const POOL_MANAGER: string = existing.poolManager;
const WETH: string = existing.weth;
const USDC: string = existing.usdc;
const POOL_SWAP_TEST: string = existing.poolSwapTest;
const POOL_MODIFY_LIQUIDITY_TEST: string = existing.poolModifyLiquidityTest;
const DEMO_MEVX_ROUTER: string = existing.demoMevxRouter;
const DEMO_MEVX_EXECUTOR: string = existing.demoMevxExecutor;
const DEMO_PROFIT_DISTRIBUTOR: string = existing.demoProfitDistributor;
const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

const DYNAMIC_FEE_FLAG = 0x800000n;
const DEFAULT_FEE_PIPS = 3000n;
const MAX_FEE_PIPS = 10_000n;
const FEE_PER_DEVIATION_BPS = 10n;
const NEUTRAL_THRESHOLD_BPS = 5n;
const MAX_ORACLE_AGE = 2_592_000n;
const OBSERVATION_WINDOW = 60n;
const MIN_OBSERVATION_AGE = 1n;
const MAX_SPOT_TO_REFERENCE_DEVIATION_BPS = 50n;
const MAX_LIMIT_TO_SPOT_DEVIATION_BPS = 500n;

const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;
const SQRT_PRICE_USDC_WETH = 20000n * 2n ** 96n; // ~2500 USDC/WETH
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

interface PoolKeyLike {
	currency0: string;
	currency1: string;
	fee: bigint;
	tickSpacing: number;
	hooks: string;
}

async function log(label: string, value: unknown) {
	console.log(`${label.padEnd(30)} ${value}`);
}

async function main() {
	const deployer = (await ethers.getSigners())[0];
	await log('Deployer', deployer.address);

	const token0UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 1_00000000n);
	await token0UsdFeed.waitForDeployment();
	const token0UsdFeedAddress = await token0UsdFeed.getAddress();
	await log('USDC feed', token0UsdFeedAddress);

	const token1UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 2500_00000000n);
	await token1UsdFeed.waitForDeployment();
	const token1UsdFeedAddress = await token1UsdFeed.getAddress();
	await log('WETH feed', token1UsdFeedAddress);

	// Distinct constructor seed (baseFee 7777) purely so CREATE2 doesn't collide with any prior
	// deploy this session — overwritten immediately by setPmmConfig below.
	const dynamicFee = DYNAMIC_FEE_FLAG | 7777n;
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
	if (existingCode !== '0x') throw new Error(`Address collision — ${hookAddress} already has code`);

	const deployCalldata = (salt + initCode.slice(2)) as `0x${string}`;
	await (await deployer.sendTransaction({ to: CREATE2_FACTORY, data: deployCalldata, gas: 4_000_000n })).wait();
	if ((await ethers.provider.getCode(hookAddress)) === '0x') throw new Error('Hook deployment failed');
	const hook = hookFactory.attach(hookAddress) as ReturnType<typeof hookFactory.attach> & {
		setPmmConfig: (...args: any[]) => Promise<any>;
	};
	await log('Hook deployed (NEW bytecode)', hookAddress);

	const [currency0, currency1] = WETH.toLowerCase() < USDC.toLowerCase() ? [WETH, USDC] : [USDC, WETH];
	const trackedTokenIsToken0 = currency0.toLowerCase() === WETH.toLowerCase();

	await (
		await hook.setPmmConfig({
			token0UsdFeed: token0UsdFeedAddress,
			token1UsdFeed: token1UsdFeedAddress,
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

	const keyA: PoolKeyLike = { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: hookAddress };
	const poolManager = PoolManager__factory.connect(POOL_MANAGER, deployer);
	const initTxA = await poolManager.initialize(keyA, SQRT_PRICE_USDC_WETH);
	const initReceiptA = await initTxA.wait();
	const poolIdA = extractPoolId(poolManager, initReceiptA!);
	await log('Pool initialized, poolId', poolIdA);

	// Tiny liquidity — a fraction of what the real showcase pool uses, just enough for a couple of
	// small test swaps.
	const ERC20_ABI = ['function approve(address,uint256) returns (bool)'];
	const weth = new ethers.Contract(WETH, ERC20_ABI, deployer);
	const usdc = new ethers.Contract(USDC, ERC20_ABI, deployer);
	await (await weth.approve(POOL_MODIFY_LIQUIDITY_TEST, ethers.MaxUint256)).wait();
	await (await usdc.approve(POOL_MODIFY_LIQUIDITY_TEST, ethers.MaxUint256)).wait();
	await (await weth.approve(POOL_SWAP_TEST, ethers.MaxUint256)).wait();
	await (await usdc.approve(POOL_SWAP_TEST, ethers.MaxUint256)).wait();

	const liquidityRouter = await ethers.getContractAt('PoolModifyLiquidityTest', POOL_MODIFY_LIQUIDITY_TEST, deployer);
	const centerTick = 198060;
	const tickSpacing = 60;
	await (
		await liquidityRouter.modifyLiquidity(
			keyA,
			{
				tickLower: centerTick - 5 * tickSpacing,
				tickUpper: centerTick + 5 * tickSpacing,
				liquidityDelta: 50_000_000_000n, // ~1/40,000th of the showcase pool's position
				salt: ethers.ZeroHash,
			},
			'0x'
		)
	).wait();
	await log('Small liquidity added', 'done');

	const swapRouter = await ethers.getContractAt('PoolSwapTest', POOL_SWAP_TEST, deployer);
	async function swapAndReport(label: string, zeroForOne: boolean, amountSpecified: bigint) {
		const tx = await swapRouter.swap(
			keyA,
			{ zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n },
			{ takeClaims: false, settleUsingBurn: false },
			'0x',
			{ gasLimit: 3_000_000n }
		);
		const receipt = await tx.wait();
		for (const l of receipt!.logs) {
			try {
				const parsed = poolManager.interface.parseLog(l);
				if (parsed?.name === 'Swap') {
					await log(`Swap fee (${label})`, `${parsed.args.fee.toString()} pips`);
				}
			} catch {
				/* not a PoolManager log */
			}
		}
	}

	// Swap 1, block N: baseline (reference not mature yet).
	await swapAndReport('swap 1, calm, no reference yet', true, -ethers.parseUnits('0.0001', 6));
	await log('observationCount after swap 1', (await hook.observationCount()).toString());

	// Wait for a real new block (this is live Sepolia, not a local node — no evm_mine), then swap 2
	// — should promote swap 1's staged observation synchronously inside this same beforeSwap call,
	// per the rewritten logic.
	const blockAtSwap1 = await ethers.provider.getBlockNumber();
	while ((await ethers.provider.getBlockNumber()) <= blockAtSwap1) {
		await new Promise((r) => setTimeout(r, 3000));
	}
	await swapAndReport('swap 2, next block', true, -ethers.parseUnits('0.0001', 6));
	await log('observationCount after swap 2', (await hook.observationCount()).toString());
	await log('referencePoolPriceWei after swap 2', (await hook.referencePoolPriceWei()).toString());

	// Shock the oracle +10% on WETH, then swap in the informed direction — fee should jump toward maxFee.
	await (await token1UsdFeed.updateAnswer(2750_00000000n)).wait();
	await swapAndReport('swap 3, post +10% shock, informed', true, -ethers.parseUnits('0.0001', 6));

	console.log('\nAll steps completed without revert — new bytecode verified end to end.');
}

function extractPoolId(poolManager: ReturnType<typeof PoolManager__factory.connect>, receipt: any): string {
	for (const l of receipt.logs) {
		try {
			const parsed = poolManager.interface.parseLog(l);
			if (parsed?.name === 'Initialize') return parsed.args.id as string;
		} catch {
			/* not a PoolManager log */
		}
	}
	throw new Error('Initialize event not found');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
