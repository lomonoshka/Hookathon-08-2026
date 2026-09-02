import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import { HomelanderUniV4PluginChainlinkPmm__factory } from '../typechain';

// token0UsdFeed (USDC/USD) is only ever set once at deploy time and never pushed again (only
// token1UsdFeed/WETH gets pushed, via "Simulate shock") — real wall-clock time passing since then
// eventually exceeds maxOracleAge (was 3600s = 1h), making _tryGetUsdPriceWei mark it stale and
// _computePmmFee silently fall back to baseFee, looking exactly like "the fee mechanism is
// broken" for anyone testing more than an hour after the last config/feed touch. Correct fix:
// raise maxOracleAge generously for this demo config — staleness protection isn't a real concern
// for a mock feed that's supposed to always be usable whenever someone visits the demo.
const existing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments-sepolia.json'), 'utf8'));
const THIRTY_DAYS = 30 * 24 * 3600;

async function main() {
	const [deployer] = await ethers.getSigners();
	const hook = HomelanderUniV4PluginChainlinkPmm__factory.connect(existing.demoHook, deployer);

	const before = await hook.pmmConfig();
	console.log('maxOracleAge BEFORE:', before.maxOracleAge.toString());

	const tx = await hook.setPmmConfig({
		token0UsdFeed: before.token0UsdFeed,
		token1UsdFeed: before.token1UsdFeed,
		token0FeedDecimals: before.token0FeedDecimals,
		token1FeedDecimals: before.token1FeedDecimals,
		baseFee: before.baseFee,
		maxFee: before.maxFee,
		feePerDeviationBps: before.feePerDeviationBps,
		neutralThresholdBps: before.neutralThresholdBps,
		maxOracleAge: THIRTY_DAYS,
		observationWindow: before.observationWindow,
		minObservationAge: before.minObservationAge,
		maxSpotToReferenceDeviationBps: before.maxSpotToReferenceDeviationBps,
		maxLimitToSpotDeviationBps: before.maxLimitToSpotDeviationBps,
		trackedTokenIsToken0: before.trackedTokenIsToken0,
		enabled: before.enabled,
	});
	await tx.wait();
	console.log('setPmmConfig tx:', tx.hash);

	const after = await hook.pmmConfig();
	console.log('maxOracleAge AFTER:', after.maxOracleAge.toString());
	// setPmmConfig also calls _clearPmmObservations() — resets the reference EMA. Expected, harmless.
	console.log('observationCount after (should be 0, reset by setPmmConfig):', await hook.observationCount());
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
