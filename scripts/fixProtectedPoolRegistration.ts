import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { DemoMevxRouter__factory } from '../typechain';

// protectedPool[poolIdA] was never set for the PMM showcase pool — HomelanderUniV4PluginChainlinkPmm
// ._afterInitialize's low-level call to DemoMevxRouter.initializePoolExternally apparently failed
// silently (fail-open .call(), no revert) during deploySepoliaPmm.ts's real broadcast. This function
// has no access control, so it can just be called directly to fix the registration retroactively.
const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));
const UNISWAP_V4_POOL_TYPE = 5;

async function main() {
	const [deployer] = await ethers.getSigners();
	const router = DemoMevxRouter__factory.connect(existing.demoMevxRouter, deployer);

	const [currency0, currency1] =
		existing.weth.toLowerCase() < existing.usdc.toLowerCase() ? [existing.weth, existing.usdc] : [existing.usdc, existing.weth];

	const before = await router.protectedPool(existing.poolIdA);
	console.log('protectedPool BEFORE:', before);

	// Matches _afterInitialize's abi.encodePacked(currency0, currency1, fee(uint24), tickSpacing(int24), hooks)
	const data = ethers.solidityPacked(
		['address', 'address', 'uint24', 'int24', 'address'],
		[currency0, currency1, 0x800000, 60, existing.demoHook]
	);
	console.log('encoded data length (bytes):', (data.length - 2) / 2);

	const tx = await router.initializePoolExternally(existing.poolIdA, UNISWAP_V4_POOL_TYPE, data);
	await tx.wait();
	console.log('Registration tx:', tx.hash);

	const after = await router.protectedPool(existing.poolIdA);
	console.log('protectedPool AFTER:', after);

	const [isArbPossible, spreadHex] = await router.initialArbCheck(existing.poolIdA, true);
	console.log('initialArbCheck: isArbPossible=', isArbPossible, 'spread(bps)=', BigInt(spreadHex).toString());
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
