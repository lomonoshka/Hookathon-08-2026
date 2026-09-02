import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4PluginChainlinkPmm__factory,
	MockV3Aggregator__factory,
	DemoMevxRouter__factory,
	DemoMevxExecutor__factory,
	PoolManager__factory,
} from '../typechain';

// Replaces the EWMA-volatility showcase pool (HomelanderUniV4Plugin) with the Chainlink
// oracle-deviation PMM hook (HomelanderUniV4PluginChainlinkPmm) as THE demo pool the dashboard
// shows by default. Reuses all the already-deployed, hook-independent infra from
// deploySepolia.ts's run (routers, DemoMevxRouter/Executor/ProfitDistributor, the vanilla Pool B
// reference pool) — only the hook itself, its two price feeds, and a fresh Pool A are new.
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
const DEFAULT_FEE_PIPS = 3000n; // 0.30% baseFee, matches the old hook's default/medium tier
const MAX_FEE_PIPS = 10_000n; // 1.00% ceiling, matches the old hook's high-vol tier
// A 10% (1000bps) demo shock should land at/near maxFee without every ordinary small swap
// saturating instantly — 10 pips-per-bps gives that headroom (deviationBps=1000 * 10 = 10_000 = maxFee).
const FEE_PER_DEVIATION_BPS = 10n;
const NEUTRAL_THRESHOLD_BPS = 5n; // 0.05% dead zone before any penalty/discount applies
const MAX_SPOT_TO_REFERENCE_DEVIATION_BPS = 50n; // 0.5% guard band — must stay well under saturation (baseFee/feePerDeviationBps = 300)
const MAX_LIMIT_TO_SPOT_DEVIATION_BPS = 500n; // 5%
const MAX_ORACLE_AGE = 3600n; // 1 hour
const OBSERVATION_WINDOW = 60n; // seconds
const MIN_OBSERVATION_AGE = 1n;

const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const SQRT_PRICE_USDC_WETH = 20000n * 2n ** 96n; // same real ~2500 USDC/WETH starting price as before

const ERC20_ABI = [
	'function deposit() payable',
	'function approve(address,uint256) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address,uint256) returns (bool)',
];

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

const REAL_DEPLOYER_ADDRESS = '0xc2bA6279D17f3F72F7283FB99DC094aE8A54BA0c';

async function main() {
	const isFork = process.env.HARDHAT_FORK !== undefined;
	const deployer = isFork ? await ethers.getImpersonatedSigner(REAL_DEPLOYER_ADDRESS) : (await ethers.getSigners())[0];
	const startBalance = await ethers.provider.getBalance(deployer.address);
	await log('Deployer', deployer.address);
	await log('Deployer ETH balance', ethers.formatEther(startBalance));

	const weth = new ethers.Contract(WETH, ERC20_ABI, deployer);
	const usdc = new ethers.Contract(USDC, ERC20_ABI, deployer);

	// ──────────────────── 1. Two controllable price feeds (USDC/USD, WETH/USD) ────────────────────
	const token0UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 1_00000000n); // USDC ≈ $1.00
	await token0UsdFeed.waitForDeployment();
	const token0UsdFeedAddress = await token0UsdFeed.getAddress();
	await log('MockV3Aggregator (USDC/USD)', token0UsdFeedAddress);

	// $2500, not a round "$2000" — must exactly match the USD price implied by the pool's own
	// bootstrap sqrtPriceX96 (SQRT_PRICE_USDC_WETH = sqrt(4e8)*2^96, chosen to encode precisely
	// 2500 USDC/WETH), or the "calm" baseline itself already reads as a large oracle deviation and
	// pins the fee at maxFee before any shock is ever pushed.
	const token1UsdFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 2500_00000000n); // WETH ≈ $2500
	await token1UsdFeed.waitForDeployment();
	const token1UsdFeedAddress = await token1UsdFeed.getAddress();
	await log('MockV3Aggregator (WETH/USD)', token1UsdFeedAddress);

	// ──────────────────── 2. Mine + deploy the PMM hook ────────────────────
	const dynamicFee = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;
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
	await log('Mined hook salt', salt);
	await log('Mined hook address', hookAddress);

	const deployCalldata = (salt + initCode.slice(2)) as `0x${string}`;
	const deployTx = await deployer.sendTransaction({ to: CREATE2_FACTORY, data: deployCalldata, gas: 4_000_000n });
	await deployTx.wait();

	const codeAtHook = await ethers.provider.getCode(hookAddress);
	if (codeAtHook === '0x') {
		throw new Error(`Hook deployment failed — no code at predicted address ${hookAddress}`);
	}
	const hook = hookFactory.attach(hookAddress);
	await log('PMM hook deployed', hookAddress);

	// ──────────────────── 3. Wire the PMM config ────────────────────
	const [currency0, currency1] = WETH.toLowerCase() < USDC.toLowerCase() ? [WETH, USDC] : [USDC, WETH];
	// currency0=USDC, currency1=WETH (same sort as the old deploy) — track token1 (WETH), the
	// volatile side, same asset the old "Simulate +10% price shock" button moved.
	const trackedTokenIsToken0 = currency0.toLowerCase() === WETH.toLowerCase();

	await (
		await hook.setPmmConfig({
			token0UsdFeed: token0UsdFeedAddress,
			token1UsdFeed: token1UsdFeedAddress,
			token0FeedDecimals: 0, // overwritten by setPmmConfig itself from the feed's real decimals()
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

	// ──────────────────── 4. Initialize the new Pool A (protected) ────────────────────
	const keyA: PoolKeyLike = { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: hookAddress };
	const poolManager = PoolManager__factory.connect(POOL_MANAGER, deployer);

	const initTxA = await poolManager.initialize(keyA, SQRT_PRICE_USDC_WETH);
	const initReceiptA = await initTxA.wait();
	const poolIdA = extractPoolId(poolManager, initReceiptA!);
	await log('New Pool A (protected) poolId', poolIdA);

	// ──────────────────── 5. Reuse the existing vanilla Pool B as this pool's arb reference ────────────────────
	// Same fixed key deploySepolia.ts already initialized on-chain (fee=1337/tickSpacing=13/no
	// hooks) — no lookup needed, just re-register it as this new pool's reference too.
	const router = DemoMevxRouter__factory.connect(DEMO_MEVX_ROUTER, deployer);
	const vanillaKeyB: PoolKeyLike = { currency0, currency1, fee: 1337n, tickSpacing: 13, hooks: ethers.ZeroAddress };
	await (await router.setReferencePool(poolIdA, vanillaKeyB)).wait();
	await log('Pool B re-registered as this pool\'s reference', 'done');

	// ──────────────────── 6. Point the shared executor at the new hook (replaces the old one) ────────────────────
	const executor = DemoMevxExecutor__factory.connect(DEMO_MEVX_EXECUTOR, deployer);
	await (await executor.setAuthorizedCaller(hookAddress)).wait();
	await log('Executor authorized caller switched to new hook', 'done');

	// ──────────────────── 7. Wrap ETH + add liquidity to the new Pool A ────────────────────
	const WETH_WRAP_AMOUNT = ethers.parseEther('0.01');
	await (await weth.deposit({ value: WETH_WRAP_AMOUNT })).wait();
	await log('Wrapped WETH', ethers.formatEther(WETH_WRAP_AMOUNT));

	for (const spender of [POOL_MODIFY_LIQUIDITY_TEST, POOL_SWAP_TEST]) {
		await (await weth.approve(spender, ethers.MaxUint256)).wait();
		await (await usdc.approve(spender, ethers.MaxUint256)).wait();
	}

	const liquidityRouter = (await ethers.getContractAt('PoolModifyLiquidityTest', POOL_MODIFY_LIQUIDITY_TEST, deployer));
	const swapRouter = (await ethers.getContractAt('PoolSwapTest', POOL_SWAP_TEST, deployer));

	const CURRENT_TICK_APPROX = Math.floor(Math.log(4e8) / Math.log(1.0001));
	const tickSpacing = Number(keyA.tickSpacing);
	const centerTick = Math.floor(CURRENT_TICK_APPROX / tickSpacing) * tickSpacing;
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
	await log('Liquidity added to new Pool A', 'done');

	const endBalance = await ethers.provider.getBalance(deployer.address);
	await log('ETH spent (gas + wrap)', ethers.formatEther(startBalance - endBalance));

	// ──────────────────── 8. Smoke-test: prove the PMM fee actually reacts to an oracle shock ────────────────────
	// trackedTokenIsToken0=false (WETH is currency1) => trackedTokenBought = zeroForOne. Buying WETH
	// (zeroForOne=true, spend USDC) while the oracle says WETH is worth MORE than the pool's own
	// implied price is the informed/value-extracting direction => the penalty branch, not the
	// discount branch a sell (zeroForOne=false) would land in for this same shock direction.
	const swapFee = async (label: string, zeroForOne: boolean, amountSpecified: bigint) => {
		const tx = await swapRouter.swap(
			keyA,
			{ zeroForOne, amountSpecified, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n },
			{ takeClaims: false, settleUsingBurn: false },
			'0x'
		);
		const receipt = await tx.wait();
		for (const logEntry of receipt!.logs) {
			try {
				const parsed = poolManager.interface.parseLog(logEntry);
				if (parsed?.name === 'Swap') {
					await log(`Swap fee (${label})`, parsed.args.fee.toString());
					return;
				}
			} catch {
				/* not a PoolManager log */
			}
		}
		throw new Error('Swap event not found');
	};

	// Sell a tiny amount of WETH (18 decimals) for the calm-market baseline check.
	await swapFee('calm market (baseFee)', false, -ethers.parseEther('0.0000005'));
	await (await token1UsdFeed.updateAnswer(2750_00000000n)).wait(); // WETH +10% (2500 -> 2750)
	// Buy WETH with a tiny amount of USDC (6 decimals, NOT parseEther's 18) — the informed
	// direction for this shock, which should show a visibly elevated penalty fee.
	await swapFee('post-shock, informed buy', true, -ethers.parseUnits('0.001', 6));

	// ──────────────────── Write results for the frontend, replacing the old showcase pool ────────────────────
	const result = {
		...existing,
		demoHookKind: 'pmm',
		demoHook: hookAddress,
		demoToken0UsdFeed: token0UsdFeedAddress,
		demoToken1UsdFeed: token1UsdFeedAddress,
		poolIdA,
	};
	const outPath = path.join(__dirname, '..', 'deployments-sepolia.json');
	fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
	console.log('\nWrote deployment addresses to', outPath);
	console.log(JSON.stringify(result, null, 2));
}

function extractPoolId(poolManager: ReturnType<typeof PoolManager__factory.connect>, receipt: ethers.ContractTransactionReceipt): string {
	for (const logEntry of receipt.logs) {
		try {
			const parsed = poolManager.interface.parseLog(logEntry);
			if (parsed?.name === 'Initialize') {
				return parsed.args.id as string;
			}
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
