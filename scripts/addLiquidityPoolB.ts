import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { PoolModifyLiquidityTest__factory } from '../typechain';

const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));
const CENTER_TICK = 198562; // computed from Pool B's current sqrtPriceX96, aligned to tickSpacing 13
const TICK_SPACING = 13;
const LIQUIDITY_DELTA = process.env.LIQUIDITY_DELTA ? BigInt(process.env.LIQUIDITY_DELTA) : 3_000_000_000_000n;

const ERC20_ABI = [
	'function approve(address,uint256) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
];

async function main() {
	const [deployer] = await ethers.getSigners();
	const usdc = new ethers.Contract(existing.usdc, ERC20_ABI, deployer);
	const weth = new ethers.Contract(existing.weth, ERC20_ABI, deployer);

	const usdcBefore = await usdc.balanceOf(deployer.address);
	const wethBefore = await weth.balanceOf(deployer.address);
	console.log('Before: USDC', ethers.formatUnits(usdcBefore, 6), 'WETH', ethers.formatEther(wethBefore));

	await (await usdc.approve(existing.poolModifyLiquidityTest, ethers.MaxUint256)).wait();
	await (await weth.approve(existing.poolModifyLiquidityTest, ethers.MaxUint256)).wait();
	console.log('Approvals set');

	const [currency0, currency1] =
		existing.weth.toLowerCase() < existing.usdc.toLowerCase() ? [existing.weth, existing.usdc] : [existing.usdc, existing.weth];
	const poolBKey = { currency0, currency1, fee: 1337, tickSpacing: TICK_SPACING, hooks: ethers.ZeroAddress };

	const liquidityRouter = PoolModifyLiquidityTest__factory.connect(existing.poolModifyLiquidityTest, deployer);
	const tx = await liquidityRouter.modifyLiquidity(
		poolBKey,
		{
			tickLower: CENTER_TICK - 200 * TICK_SPACING,
			tickUpper: CENTER_TICK + 200 * TICK_SPACING,
			liquidityDelta: LIQUIDITY_DELTA,
			salt: ethers.ZeroHash,
		},
		'0x',
		{ gasLimit: 3_000_000n }
	);
	await tx.wait();
	console.log('Liquidity tx:', tx.hash);

	const usdcAfter = await usdc.balanceOf(deployer.address);
	const wethAfter = await weth.balanceOf(deployer.address);
	console.log('After: USDC', ethers.formatUnits(usdcAfter, 6), 'WETH', ethers.formatEther(wethAfter));
	console.log('Spent: USDC', ethers.formatUnits(usdcBefore - usdcAfter, 6), 'WETH', ethers.formatEther(wethBefore - wethAfter));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
