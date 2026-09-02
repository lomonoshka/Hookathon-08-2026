import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { PoolManager__factory, PoolSwapTest__factory, DemoMevxExecutor__factory } from '../typechain';

const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));
const MIN_SQRT_PRICE = 4295128739n;

async function main() {
	const [deployer] = await ethers.getSigners();
	const poolManager = PoolManager__factory.connect(existing.poolManager, deployer);
	const swapRouter = PoolSwapTest__factory.connect(existing.poolSwapTest, deployer);
	const executor = DemoMevxExecutor__factory.connect(existing.demoMevxExecutor, deployer);

	const [currency0, currency1] =
		existing.weth.toLowerCase() < existing.usdc.toLowerCase() ? [existing.weth, existing.usdc] : [existing.usdc, existing.weth];
	const poolAKey = { currency0, currency1, fee: 0x800000, tickSpacing: 60, hooks: existing.demoHook };

	const tx = await swapRouter.swap(
		poolAKey,
		{ zeroForOne: true, amountSpecified: -ethers.parseUnits('0.001', 6), sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n },
		{ takeClaims: false, settleUsingBurn: false },
		'0x',
		{ gasLimit: 7_000_000n }
	);
	const receipt = await tx.wait();
	console.log('tx:', tx.hash);

	let feePips: bigint | undefined;
	let captured = false;
	for (const log of receipt!.logs) {
		try {
			const p = poolManager.interface.parseLog(log);
			if (p?.name === 'Swap') feePips = p.args.fee;
		} catch {}
		try {
			const p = executor.interface.parseLog(log);
			if (p?.name === 'ArbitrageExecuted') {
				captured = true;
				console.log('ArbitrageExecuted! profitToken=', p.args.profitToken, 'profit=', p.args.profit.toString());
			}
		} catch {}
	}
	console.log('\n=== FINAL RESULT ===');
	console.log('Fee paid:', feePips?.toString(), `(${feePips ? Number(feePips)/10000 : '?'}%)`);
	console.log('Capture executed in same tx:', captured);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
