import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { PoolManager__factory, PoolSwapTest__factory, DemoMevxRouter__factory } from '../typechain';

// Pool B has been repeatedly pushed the same direction (zeroForOne=false, sell WETH) throughout
// this session's testing and its thin liquidity is now pinned at MAX_SQRT_PRICE — further pushes
// in that direction are no-ops. This does the opposite trade (zeroForOne=true, spend USDC to buy
// WETH) to bring the price back down and free up room again. Small, deliberately conservative
// amount — the wallet's remaining test USDC balance is limited.
const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));

const MIN_SQRT_PRICE = 4295128739n;

function priceFromSqrt(sqrtPriceX96: bigint): bigint {
	return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / 2n ** 192n;
}

async function main() {
	const [deployer] = await ethers.getSigners();
	const usdcAmount = process.argv[2] ? ethers.parseUnits(process.argv[2], 6) : ethers.parseUnits('0.05', 6);
	console.log('signer', deployer.address, 'spending', ethers.formatUnits(usdcAmount, 6), 'USDC');

	const poolManager = PoolManager__factory.connect(existing.poolManager, deployer);
	const swapRouter = PoolSwapTest__factory.connect(existing.poolSwapTest, deployer);
	const router = DemoMevxRouter__factory.connect(existing.demoMevxRouter, deployer);

	const [currency0, currency1] =
		existing.weth.toLowerCase() < existing.usdc.toLowerCase() ? [existing.weth, existing.usdc] : [existing.usdc, existing.weth];
	const poolBKey = { currency0, currency1, fee: 1337, tickSpacing: 13, hooks: ethers.ZeroAddress };

	const usdc = new ethers.Contract(existing.usdc, ['function approve(address,uint256) returns (bool)'], deployer);
	const allowanceCheck = new ethers.Contract(
		existing.usdc,
		['function allowance(address,address) view returns (uint256)'],
		deployer
	);
	const allowance = await allowanceCheck.allowance(deployer.address, existing.poolSwapTest);
	if (allowance < usdcAmount) {
		await (await usdc.approve(existing.poolSwapTest, ethers.MaxUint256)).wait();
		console.log('Approved USDC');
	}

	const tx = await swapRouter.swap(
		poolBKey,
		{ zeroForOne: true, amountSpecified: -usdcAmount, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n },
		{ takeClaims: false, settleUsingBurn: false },
		'0x',
		{ gasLimit: 2_000_000n }
	);
	const receipt = await tx.wait();
	console.log('Rebalance tx:', tx.hash);

	for (const log of receipt!.logs) {
		try {
			const parsed = poolManager.interface.parseLog(log);
			if (parsed?.name === 'Swap') {
				const newPrice = priceFromSqrt(BigInt(parsed.args.sqrtPriceX96));
				console.log('New Pool B sqrtPriceX96:', parsed.args.sqrtPriceX96.toString());
				console.log('New Pool B price (1e18-scaled):', newPrice.toString());
			}
		} catch {
			/* not a PoolManager log */
		}
	}

	const [isArbPossible, spreadHex] = await router.initialArbCheck(existing.poolIdA, true);
	console.log('Post-rebalance arb check vs Pool A: isArbPossible=', isArbPossible, 'spread(bps)=', BigInt(spreadHex).toString());
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
