import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { mineHookSalt, HookFlags } from '../helper-tools/uniswapV4/hookMiner';
import {
	HomelanderUniV4Plugin__factory,
	PoolSwapTest__factory,
	PoolModifyLiquidityTest__factory,
	MockV3Aggregator__factory,
	DemoMevxRouter__factory,
	DemoMevxExecutor__factory,
	DemoProfitDistributor__factory,
	PoolManager__factory,
} from '../typechain';

// ──────────────────── Verified real Sepolia addresses (see conversation/docs for sources) ────────────────────
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543';
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const CHAINLINK_ETH_USD = '0x694AA1769357215DE4FAC081bf1f309aDC325306';
const CREATE2_FACTORY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';

const DYNAMIC_FEE_FLAG = 0x800000n;
const DEFAULT_FEE_PIPS = 3000n; // 0.30%
const LOW_VOL_FEE_PIPS = 500n; // 0.05%
const HIGH_VOL_FEE_PIPS = 10_000n; // 1.00%
const LOW_VOL_THRESHOLD = 5n;
const HIGH_VOL_THRESHOLD = 50n;

// DemoMevxRouter: minimum divergence before it treats a swap as arbable. Deliberately high —
// this should be a rare, obvious "we pushed Pool B, watch the capture happen" demo moment, not
// something that fires on every incidental swap against our (deliberately thin) real-capital
// liquidity. 20bps fired on literally the first tiny setup swap and ran away; 300bps (3%) does not.
const MIN_SPREAD_BPS = 300n;

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
// currency0 = USDC (6 decimals), currency1 = WETH (18 decimals) once sorted by address — a naive
// "1:1 raw units" price ignores that 12-decimal gap and implies WETH is worth ~1e-12 USDC, which
// makes even a tiny arbitrage leg trade an absurdly (10^12x) inflated raw amount and crash the
// pool to the price floor regardless of liquidity depth. This encodes a realistic ~2500 USDC/WETH.
const SQRT_PRICE_USDC_WETH = 20000n * 2n ** 96n; // sqrt(4e8) * 2^96
const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;

const WETH_WRAP_AMOUNT = ethers.parseEther('0.03');
const EXECUTOR_WETH_FUNDING = ethers.parseEther('0.005');
const EXECUTOR_USDC_FUNDING = ethers.parseUnits('2', 6);

const ERC20_ABI = [
	'function deposit() payable',
	'function approve(address,uint256) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address,uint256) returns (bool)',
	'function allowance(address,address) view returns (uint256)',
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
	// On a fork (--network hardhat with HARDHAT_FORK set), impersonate our REAL funded address
	// so this dry run is honest about actual balance constraints — hardhat's default test
	// accounts get a fake 10,000 ETH top-up and may hold unrelated real testnet token balances,
	// which silently masked an earlier liquidity-sizing bug that our real ~20 USDC would hit.
	const isFork = process.env.HARDHAT_FORK !== undefined;
	const deployer = isFork ? await ethers.getImpersonatedSigner(REAL_DEPLOYER_ADDRESS) : (await ethers.getSigners())[0];
	const startBalance = await ethers.provider.getBalance(deployer.address);
	await log('Deployer', deployer.address);
	await log('Deployer ETH balance', ethers.formatEther(startBalance));

	const weth = new ethers.Contract(WETH, ERC20_ABI, deployer);
	const usdc = new ethers.Contract(USDC, ERC20_ABI, deployer);

	// ──────────────────── 1. Periphery test routers ────────────────────
	const swapRouter = await new PoolSwapTest__factory(deployer).deploy(POOL_MANAGER);
	await swapRouter.waitForDeployment();
	const swapRouterAddress = await swapRouter.getAddress();
	await log('PoolSwapTest', swapRouterAddress);

	const liquidityRouter = await new PoolModifyLiquidityTest__factory(deployer).deploy(POOL_MANAGER);
	await liquidityRouter.waitForDeployment();
	const liquidityRouterAddress = await liquidityRouter.getAddress();
	await log('PoolModifyLiquidityTest', liquidityRouterAddress);

	// ──────────────────── 2. Demo arbitrage stack (fresh, original code) ────────────────────
	const router = await new DemoMevxRouter__factory(deployer).deploy(POOL_MANAGER, deployer.address);
	await router.waitForDeployment();
	const routerAddress = await router.getAddress();
	await log('DemoMevxRouter', routerAddress);

	// DemoMevxExecutor.executeRoute always runs inside a hook's _afterSwap (an already-unlocked
	// PoolManager), so it must call PoolManager.swap() directly rather than through PoolSwapTest
	// (which always calls its own unlock() and reverts with AlreadyUnlocked when nested) — see
	// contracts/demo-arbitrage/DemoMevxExecutor.sol.
	const executor = await new DemoMevxExecutor__factory(deployer).deploy(POOL_MANAGER, deployer.address);
	await executor.waitForDeployment();
	const executorAddress = await executor.getAddress();
	await log('DemoMevxExecutor', executorAddress);

	const distributor = await new DemoProfitDistributor__factory(deployer).deploy(deployer.address, deployer.address);
	await distributor.waitForDeployment();
	const distributorAddress = await distributor.getAddress();
	await log('DemoProfitDistributor', distributorAddress);

	// ──────────────────── 3. Our controllable mock feed for the showcase demo pool ────────────────────
	const mockFeed = await new MockV3Aggregator__factory(deployer).deploy(8, 2000_00000000n);
	await mockFeed.waitForDeployment();
	const mockFeedAddress = await mockFeed.getAddress();
	await log('MockV3Aggregator (demo feed)', mockFeedAddress);

	// ──────────────────── 4. Mine + deploy the hook via the canonical CREATE2 factory ────────────────────
	const dynamicFee = DYNAMIC_FEE_FLAG | DEFAULT_FEE_PIPS;
	const hookFactory = new HomelanderUniV4Plugin__factory(deployer);
	const constructorArgs = [POOL_MANAGER, deployer.address, routerAddress, executorAddress, distributorAddress, dynamicFee] as const;
	const initCode = (hookFactory.bytecode + hookFactory.interface.encodeDeploy(constructorArgs).slice(2)) as `0x${string}`;

	const { salt, hookAddress } = mineHookSalt(CREATE2_FACTORY, HOOK_FLAGS, initCode);
	await log('Mined hook salt', salt);
	await log('Mined hook address', hookAddress);

	const deployCalldata = (salt + initCode.slice(2)) as `0x${string}`;
	const deployTx = await deployer.sendTransaction({ to: CREATE2_FACTORY, data: deployCalldata });
	await deployTx.wait();

	const codeAtHook = await ethers.provider.getCode(hookAddress);
	if (codeAtHook === '0x') {
		throw new Error(`Hook deployment failed — no code at predicted address ${hookAddress}`);
	}
	const hook = hookFactory.attach(hookAddress);
	await log('Hook deployed', hookAddress);

	// ──────────────────── 5. Wire the hook to our demo feed + fee tiers ────────────────────
	await (await hook.setPriceFeed(mockFeedAddress)).wait();
	await (await hook.setVolatilityFeeTiers(LOW_VOL_FEE_PIPS, HIGH_VOL_FEE_PIPS, LOW_VOL_THRESHOLD, HIGH_VOL_THRESHOLD)).wait();
	await log('Hook wired to demo feed + tiers', 'done');

	// ──────────────────── 6. Initialize Pool A (protected) and Pool B (vanilla reference) ────────────────────
	const [currency0, currency1] = WETH.toLowerCase() < USDC.toLowerCase() ? [WETH, USDC] : [USDC, WETH];
	const keyA: PoolKeyLike = { currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: hookAddress };
	// Deliberately unusual fee/tickSpacing so this vanilla reference pool doesn't collide with
	// someone else's already-initialized WETH/USDC pool on Sepolia (PoolAlreadyInitialized) —
	// confirmed by hitting exactly that revert with the standard 3000/60 combo.
	const keyB: PoolKeyLike = { currency0, currency1, fee: 1337n, tickSpacing: 13, hooks: ethers.ZeroAddress };

	const poolManager = PoolManager__factory.connect(POOL_MANAGER, deployer);

	const initTxA = await poolManager.initialize(keyA, SQRT_PRICE_USDC_WETH);
	const initReceiptA = await initTxA.wait();
	const poolIdA = extractPoolId(poolManager, initReceiptA!);
	await log('Pool A (protected) poolId', poolIdA);

	const initTxB = await poolManager.initialize(keyB, SQRT_PRICE_USDC_WETH);
	const initReceiptB = await initTxB.wait();
	const poolIdB = extractPoolId(poolManager, initReceiptB!);
	await log('Pool B (reference) poolId', poolIdB);

	// ──────────────────── 7. Register Pool B as Pool A's arbitrage reference ────────────────────
	await (await router.setReferencePool(poolIdA, keyB)).wait();
	await (await router.setMinSpreadBps(MIN_SPREAD_BPS)).wait();
	// Default demoTradeAmount (0.01 ETH) is far too large for our deliberately thin real-capital
	// liquidity — a single internal arb leg at that size would fully drain the pool to the price
	// floor. Scale it down to match what our liquidity can actually absorb.
	await (await router.setDemoTradeAmount(ethers.parseEther('0.0002'))).wait();
	await log('Reference pool registered', 'done');

	// ──────────────────── 8. Wrap ETH into WETH ────────────────────
	await (await weth.deposit({ value: WETH_WRAP_AMOUNT })).wait();
	await log('Wrapped WETH', ethers.formatEther(WETH_WRAP_AMOUNT));

	// ──────────────────── 9. Approve + add liquidity to both pools ────────────────────
	for (const spender of [liquidityRouterAddress, swapRouterAddress]) {
		await (await weth.approve(spender, ethers.MaxUint256)).wait();
		await (await usdc.approve(spender, ethers.MaxUint256)).wait();
	}
	await log('Approvals set for routers', 'done');

	// tickLower/tickUpper must (a) straddle the pool's ACTUAL current tick — not tick 0 — and
	// (b) be exact multiples of the pool's own tickSpacing. Missing (a) was the real bug behind
	// every earlier "swap crashes straight to the price floor" failure: a range centered on tick
	// 0 (price ~1.0) is entirely on one side of our real ~2500 USDC/WETH starting price (tick
	// ~198,080), so it deposits everything as one-sided liquidity — zero depth at the price
	// swaps actually execute at.
	const CURRENT_TICK_APPROX = Math.floor(Math.log(4e8) / Math.log(1.0001)); // matches SQRT_PRICE_USDC_WETH
	const liquidityParamsFor = (tickSpacing: number) => {
		const centerTick = Math.floor(CURRENT_TICK_APPROX / tickSpacing) * tickSpacing;
		return {
			tickLower: centerTick - 20 * tickSpacing,
			tickUpper: centerTick + 20 * tickSpacing,
			// Sized to fit our real ~20 USDC balance (minus 2 USDC reserved for executor funding)
			// across both pools — measured empirically: 1e13 delta consumed ~34.8 USDC total.
			liquidityDelta: ethers.parseUnits('5000000000000', 0),
			salt: ethers.ZeroHash,
		};
	};

	await (await liquidityRouter.modifyLiquidity(keyA, liquidityParamsFor(Number(keyA.tickSpacing)), '0x')).wait();
	await log('Liquidity added to Pool A', 'done');
	await (await liquidityRouter.modifyLiquidity(keyB, liquidityParamsFor(Number(keyB.tickSpacing)), '0x')).wait();
	await log('Liquidity added to Pool B', 'done');

	// ──────────────────── 10. Fund the executor so it can actually execute arb legs ────────────────────
	// No approvals needed — DemoMevxExecutor settles by transferring straight from its own balance
	// (CurrencySettler.settle's payer==address(this) path), not transferFrom.
	await (await weth.transfer(executorAddress, EXECUTOR_WETH_FUNDING)).wait();
	await (await usdc.transfer(executorAddress, EXECUTOR_USDC_FUNDING)).wait();
	await (await executor.setAuthorizedCaller(hookAddress)).wait();
	await log('Executor funded', 'done');

	const endBalance = await ethers.provider.getBalance(deployer.address);
	await log('ETH spent (gas + wrap)', ethers.formatEther(startBalance - endBalance));

	// ──────────────────── 11. Smoke-test swap: prove the fee tier actually reacts to price ────────────────────
	const swapFee = async (label: string) => {
		// The absolute floor, not a fixed offset from the starting price — a fixed offset can end
		// up *behind* where a prior swap (plus any internal arb-capture leg it triggered) already
		// pushed the price, which reads as "limit already exceeded" before this swap even runs.
		// zeroForOne=false: give currency1 (WETH, 18 decimals — matches parseEther), receive
		// currency0 (USDC). Using zeroForOne=true here would spend currency0=USDC using an
		// 18-decimals-scaled amount — a 10^12x oversized trade relative to what "0.00005" means
		// in USDC's 6 decimals, which is exactly what crashed every earlier attempt at this step.
		const tx = await swapRouter.swap(
			keyA,
			{ zeroForOne: false, amountSpecified: -ethers.parseEther('0.0000005'), sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n },
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
				// not a PoolManager log
			}
		}
		throw new Error('Swap event not found');
	};

	await swapFee('calm market');
	await (await mockFeed.updateAnswer(2200_00000000n)).wait(); // +10% price shock
	await swapFee('post-shock, lagged'); // still low tier — fee only updates via afterSwap
	await swapFee('post-shock, settled'); // should now show the high-vol tier

	// ──────────────────── Write results for the frontend ────────────────────
	const result = {
		network: 'sepolia',
		poolManager: POOL_MANAGER,
		poolSwapTest: swapRouterAddress,
		poolModifyLiquidityTest: liquidityRouterAddress,
		weth: WETH,
		usdc: USDC,
		chainlinkEthUsdFeed: CHAINLINK_ETH_USD,
		demoMockPriceFeed: mockFeedAddress,
		demoMevxRouter: routerAddress,
		demoMevxExecutor: executorAddress,
		demoProfitDistributor: distributorAddress,
		demoHook: hookAddress,
		poolIdA,
		poolIdB,
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
