import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { PoolManager__factory, PoolSwapTest__factory, MockV3Aggregator__factory, DemoMevxRouter__factory, DemoMevxExecutor__factory } from '../typechain';

// One-off verification: replicates exactly what OneClickDemoButton.tsx does (push Pool B, shock
// the oracle, one swap in the protected pool) directly against the real deployed contracts, to
// confirm a single swap really does show both an elevated fee AND a real capture — without
// needing to click through MetaMask in a browser.
const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log('signer', deployer.address);

	const poolManager = PoolManager__factory.connect(existing.poolManager, deployer);
	const swapRouter = PoolSwapTest__factory.connect(existing.poolSwapTest, deployer);
	const router = DemoMevxRouter__factory.connect(existing.demoMevxRouter, deployer);
	const token1UsdFeed = MockV3Aggregator__factory.connect(existing.demoToken1UsdFeed, deployer);
	const executor = DemoMevxExecutor__factory.connect(existing.demoMevxExecutor, deployer);

	const [currency0, currency1] =
		existing.weth.toLowerCase() < existing.usdc.toLowerCase() ? [existing.weth, existing.usdc] : [existing.usdc, existing.weth];
	const poolAKey = { currency0, currency1, fee: 0x800000, tickSpacing: 60, hooks: existing.demoHook };

	// ── 1. Push Pool B ──
	const [refCurrency0, refCurrency1, refFee, refTickSpacing, refHooks] = await router.referencePool(existing.poolIdA);
	const poolBKey = { currency0: refCurrency0, currency1: refCurrency1, fee: refFee, tickSpacing: refTickSpacing, hooks: refHooks };
	console.log('Pool B key', poolBKey);

	const pushTx = await swapRouter.swap(
		poolBKey,
		{ zeroForOne: false, amountSpecified: -ethers.parseEther('0.005'), sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n },
		{ takeClaims: false, settleUsingBurn: false },
		'0x',
		{ gasLimit: 2_000_000n }
	);
	await pushTx.wait();
	console.log('Pushed Pool B:', pushTx.hash);

	// ── 2. Shock the oracle ──
	const current = await token1UsdFeed.latestAnswer();
	const shocked = (current * 110n) / 100n;
	const shockTx = await token1UsdFeed.updateAnswer(shocked);
	await shockTx.wait();
	console.log(`Shocked oracle: ${current} -> ${shocked}`);

	// ── 3. Check the spread is now capturable before the demo swap ──
	const [isArbPossible, spreadHex] = await router.initialArbCheck(existing.poolIdA, true);
	console.log('Pre-swap arb check: isArbPossible=', isArbPossible, 'spread(bps)=', BigInt(spreadHex).toString());

	// ── 4. One swap in the protected pool: buy WETH (zeroForOne=true) ──
	const swapTx = await swapRouter.swap(
		poolAKey,
		{ zeroForOne: true, amountSpecified: -ethers.parseUnits('0.001', 6), sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n },
		{ takeClaims: false, settleUsingBurn: false },
		'0x',
		{ gasLimit: 7_000_000n }
	);
	const receipt = await swapTx.wait();
	console.log('Demo swap tx:', swapTx.hash);

	let feePips: bigint | undefined;
	let captured = false;
	for (const log of receipt!.logs) {
		try {
			const parsed = poolManager.interface.parseLog(log);
			if (parsed?.name === 'Swap') feePips = parsed.args.fee as bigint;
		} catch {
			/* not a PoolManager log */
		}
		try {
			const parsed = executor.interface.parseLog(log);
			if (parsed?.name === 'ArbitrageExecuted') {
				captured = true;
				console.log('ArbitrageExecuted:', parsed.args.profitToken, parsed.args.profit.toString());
			}
		} catch {
			/* not a DemoMevxExecutor log */
		}
	}

	console.log('\n=== RESULT ===');
	console.log('Fee paid on this single swap:', feePips?.toString(), `(${feePips ? Number(feePips) / 10_000 : '?'}%)`);
	console.log('Capture executed in the SAME transaction:', captured);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
