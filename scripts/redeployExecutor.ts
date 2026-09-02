import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { DemoMevxExecutor__factory, HomelanderUniV4PluginChainlinkPmm__factory } from '../typechain';

const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));
const ERC20_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

async function main() {
	const [deployer] = await ethers.getSigners();

	const executor = await new DemoMevxExecutor__factory(deployer).deploy(existing.poolManager, deployer.address);
	await executor.waitForDeployment();
	const executorAddress = await executor.getAddress();
	console.log('New DemoMevxExecutor:', executorAddress);

	await (await executor.setAuthorizedCaller(existing.demoHook)).wait();
	console.log('authorizedCaller set to hook:', existing.demoHook);

	const weth = new ethers.Contract(existing.weth, ERC20_ABI, deployer);
	const usdc = new ethers.Contract(existing.usdc, ERC20_ABI, deployer);
	await (await weth.transfer(executorAddress, ethers.parseEther('0.002'))).wait();
	await (await usdc.transfer(executorAddress, ethers.parseUnits('0.5', 6))).wait();
	console.log('Funded: 0.002 WETH + 0.5 USDC');

	const hook = HomelanderUniV4PluginChainlinkPmm__factory.connect(existing.demoHook, deployer);
	await (await hook.setMevxExecutor(executorAddress)).wait();
	console.log('Hook mevxExecutor updated to:', executorAddress);

	const wethBal = await weth.balanceOf(executorAddress);
	const usdcBal = await usdc.balanceOf(executorAddress);
	console.log('New executor balances: WETH', ethers.formatEther(wethBal), 'USDC', ethers.formatUnits(usdcBal, 6));

	const result = { ...existing, demoMevxExecutor: executorAddress };
	fs.writeFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), JSON.stringify(result, null, 2));
	console.log('Updated deployments-sepolia.json');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
