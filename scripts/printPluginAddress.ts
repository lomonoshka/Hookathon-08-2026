import { artifacts } from 'hardhat';
import { CREATE2_DEPLOYER } from '../helper-tools/uniswapV4/hookMiner';
import { PLUGIN_DYNAMIC_FEE, computeHookAddress, pluginConstructorArgs, poolIdOf, poolKeyFor } from './lib/pluginDeployment';

/**
 * Prints the CREATE2 salt, hook address and poolId for a given plugin owner.
 *
 *   OWNER=0x... npx hardhat run scripts/printPluginAddress.ts
 *
 * Deploy by sending `salt ++ initCode` to the Arachnid CREATE2 deployer. Both values move with
 * the plugin bytecode and the constructor arguments, so recompute after any change to either —
 * and reload the routes, which are keyed by poolId.
 */
async function main() {
	const owner = process.env.OWNER;
	if (!owner) throw new Error('OWNER is required (the address that will own the deployed plugin)');

	const artifact = await artifacts.readArtifact('HomelanderUniV4Plugin');
	const { salt, hookAddress } = computeHookAddress(artifact.bytecode, owner);

	console.log(`owner:      ${owner}`);
	console.log(`ctor args:  ${JSON.stringify(pluginConstructorArgs(owner))}`);
	console.log(`plugin fee: ${PLUGIN_DYNAMIC_FEE} (0x${PLUGIN_DYNAMIC_FEE.toString(16)})`);
	console.log(`deployer:   ${CREATE2_DEPLOYER}`);
	console.log(`salt:       ${salt}`);
	console.log(`HOOK:       ${hookAddress}`);
	console.log(`poolId:     ${poolIdOf(poolKeyFor(hookAddress))}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
