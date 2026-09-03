import { ethers, artifacts, network } from 'hardhat';
import { expect } from 'chai';
import { Signer } from 'ethers';
import { HttpNetworkConfig } from 'hardhat/types';
import { CREATE2_DEPLOYER, HOOK_FLAG_MASK } from '../../helper-tools/uniswapV4/hookMiner';
import {
	BASE,
	EXPECTED_HOOK_FLAGS,
	PLUGIN_OWNER,
	TICK_SPACING,
	computeHookAddress,
	poolIdOf,
	poolKeyFor,
} from '../../scripts/lib/pluginDeployment';

const POOL_MANAGER_ABI = [
	'function initialize((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint160 sqrtPriceX96) returns (int24)',
	'event Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)',
];
const STATE_VIEW_ABI = [
	'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
	'function getLiquidity(bytes32 poolId) view returns (uint128)',
	'function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)',
];
const V3_POOL_ABI = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'];
const ERC20_ABI = [
	'function balanceOf(address) view returns (uint256)',
	'function approve(address,uint256) returns (bool)',
	'function decimals() view returns (uint8)',
];
const ROUTE_READ_ABI = [
	'function getRoutes(bytes32 targetPool, bool zeroToOne) view returns ((address startToken,uint8 routeLength,uint64 amountOutNumerator,(address poolAddress,uint16 poolType,uint16 fee,bool shouldUpdateFeeBeforeSwap,bool zeroForOne,bytes32 poolId,bytes data)[3] route)[])',
];
const ROUTER_DIAG_ABI = [
	'function initialArbCheck(bytes32 poolId, bool zeroToOne) view returns (bool isArbPossible, bytes16 priceChange)',
	'event InitialArbCheckSkipped(address indexed plugin, bytes32 indexed poolId, uint8 reason)',
	'event ArbitrageExecutionFailed(address indexed plugin, uint8 reason, bytes revertData)',
];

/** Full range for tickSpacing 10: the pool then behaves like x*y=k over the seeded reserves. */
const TICK_LOWER = -887270;
const TICK_UPPER = 887270;

/**
 * When the test runs against an external node (anvil), hardhat signs locally and refuses any
 * account it does not hold the key for. Impersonated transactions have to be handed straight to
 * the node, which is what a plain JsonRpcProvider signer does.
 */
async function impersonate(address: string): Promise<Signer> {
	await network.provider.send('hardhat_setBalance', [address, '0x' + (10n ** 21n).toString(16)]);
	await network.provider.request({ method: 'hardhat_impersonateAccount', params: [address] });

	const url = (network.config as HttpNetworkConfig).url;
	if (!url) return ethers.getSigner(address);
	return new ethers.JsonRpcProvider(url).getSigner(address);
}

/**
 * Writes a USDC balance directly. The balance mapping slot is probed rather than hardcoded so
 * the test survives a proxy implementation swap.
 */
async function dealUsdc(to: string, amount: bigint): Promise<void> {
	const usdc = new ethers.Contract(BASE.usdc, ERC20_ABI, ethers.provider);
	const value = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
	for (let slot = 0; slot < 20; slot++) {
		const key = ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [to, slot])
		);
		const previous = await ethers.provider.getStorage(BASE.usdc, key);
		await network.provider.send('hardhat_setStorageAt', [BASE.usdc, key, value]);
		if ((await usdc.balanceOf(to)) === amount) return;
		await network.provider.send('hardhat_setStorageAt', [BASE.usdc, key, previous]);
	}
	throw new Error('could not locate the USDC balance slot');
}

const V4_SWAP_ABI = [
	'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
];
const V3_SWAP_ABI = [
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

/** Signed amount from the swapper's point of view: negative is paid in, positive is received. */
function signed(amount: bigint, decimals: number, symbol: string): string {
	const sign = amount < 0n ? '-' : '+';
	return `${sign}${ethers.formatUnits(amount < 0n ? -amount : amount, decimals)} ${symbol}`;
}

/**
 * Walks the swap receipt in log order and describes every leg, so the profit is traceable:
 * the user's swap moves the V4 price, then the executor buys the now-cheap ETH there and sells
 * it on V3 at the untouched price. V3 reports amounts from the pool's side, so they are negated
 * to match V4's swapper-side convention.
 */
function describeSwapLegs(logs: readonly any[], poolId: string): string[] {
	const v4 = new ethers.Interface(V4_SWAP_ABI);
	const v3 = new ethers.Interface(V3_SWAP_ABI);
	const v4Topic = v4.getEvent('Swap')!.topicHash;
	const v3Topic = v3.getEvent('Swap')!.topicHash;
	const out: string[] = [];

	for (const log of logs) {
		const address = log.address.toLowerCase();
		if (address === BASE.poolManager.toLowerCase() && log.topics[0] === v4Topic && log.topics[1] === poolId) {
			const { args } = v4.parseLog({ topics: [...log.topics], data: log.data })!;
			const who =
				ethers.getAddress(args.sender) === ethers.getAddress(BASE.mevxExecutor) ? 'executor' : 'user    ';
			out.push(
				`V4 ETH/USDC  ${who}  ${signed(args.amount0, 18, 'ETH')}  ${signed(args.amount1, 6, 'USDC')}`
			);
		} else if (address === BASE.v3WethUsdc.toLowerCase() && log.topics[0] === v3Topic) {
			const { args } = v3.parseLog({ topics: [...log.topics], data: log.data })!;
			out.push(
				`V3 WETH/USDC executor  ${signed(-args.amount0, 18, 'WETH')}  ${signed(-args.amount1, 6, 'USDC')}`
			);
		}
	}
	return out;
}

function decodeDiagnostics(logs: readonly any[]): string[] {
	const iface = new ethers.Interface(ROUTER_DIAG_ABI);
	const out: string[] = [];
	for (const log of logs) {
		try {
			const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
			if (parsed) out.push(`${parsed.name}(${parsed.args.map((a: unknown) => String(a)).join(', ')})`);
		} catch {
			/* not a router diagnostic */
		}
	}
	return out;
}

describe('HomelanderUniV4Plugin — arbitrage profit donated to LPs (Base fork)', function () {
	this.timeout(600_000);

	it('a user swap triggers the backrun and the profit lands with the pool LPs', async () => {
		const [deployer, lp, trader] = await ethers.getSigners();
		// The plugin owner is fixed, not the local deployer: it feeds the CREATE2 init code, so
		// using a local account would move the hook address away from the one the mainnet routes
		// are keyed to. The CREATE2 deploy itself can be sent by anyone.
		const ownerAddress = ethers.getAddress(PLUGIN_OWNER);

		// ── 1. Deterministic plugin deploy: the mined address is what routes are keyed by. ──
		const artifact = await artifacts.readArtifact('HomelanderUniV4Plugin');
		const { salt, hookAddress, initCode } = computeHookAddress(artifact.bytecode, ownerAddress);
		const poolKey = poolKeyFor(hookAddress);
		const poolId = poolIdOf(poolKey);
		console.log(`      hook   ${hookAddress}`);
		console.log(`      poolId ${poolId}`);

		await (
			await deployer.sendTransaction({ to: CREATE2_DEPLOYER, data: ethers.concat([salt, initCode]) })
		).wait();
		expect(await ethers.provider.getCode(hookAddress)).to.not.equal('0x');
		expect(BigInt(hookAddress) & HOOK_FLAG_MASK).to.equal(EXPECTED_HOOK_FLAGS);

		const plugin = await ethers.getContractAt('HomelanderUniV4Plugin', hookAddress, deployer);

		// ── 2. All arbitrage profit goes to the LPs; nothing reaches the distributor. ──
		const owner = await impersonate(ownerAddress);
		await (await plugin.connect(owner).setDefaultLpShareBps(10_000)).wait();

		// ── 3. Create the pool at the V3 mid price. Same currency ordering (ETH/WETH is
		//       currency0 in both), so the sqrt price carries over unchanged. ──
		const v3Pool = new ethers.Contract(BASE.v3WethUsdc, V3_POOL_ABI, ethers.provider);
		const [v3SqrtPriceX96] = await v3Pool.slot0();
		const ethPriceUsdc = (Number(v3SqrtPriceX96) / 2 ** 96) ** 2 * 1e12;
		console.log(`      ETH/USDC on V3: ${ethPriceUsdc.toFixed(2)}`);

		const poolManager = new ethers.Contract(BASE.poolManager, POOL_MANAGER_ABI, deployer);
		await (await poolManager.initialize(poolKey, v3SqrtPriceX96)).wait();

		const stateView = new ethers.Contract(BASE.stateView, STATE_VIEW_ABI, ethers.provider);
		expect((await stateView.getSlot0(poolId)).sqrtPriceX96).to.equal(v3SqrtPriceX96);

		// afterInitialize registers the pool with MevxRouter; without it there is no arb path.
		const routerDiag = new ethers.Contract(BASE.mevxRouter, ROUTER_DIAG_ABI, ethers.provider);
		await routerDiag.initialArbCheck.staticCall(poolId, true);

		// ── 4. Seed 100k USDC and the ETH equivalent (~41.6 ETH at the current price). ──
		const usdcAmount = 100_000n * 10n ** 6n;
		const ethAmount = (usdcAmount * 10n ** 12n * 10n ** 18n) / BigInt(Math.round(ethPriceUsdc * 1e18));
		console.log(`      seeding ${ethers.formatEther(ethAmount)} ETH + 100000 USDC`);

		const testRouter = await (await ethers.getContractFactory('V4TestRouter', deployer)).deploy(BASE.poolManager);
		await testRouter.waitForDeployment();
		const testRouterAddress = await testRouter.getAddress();

		await network.provider.send('hardhat_setBalance', [
			await lp.getAddress(),
			'0x' + (ethAmount * 2n).toString(16),
		]);
		await dealUsdc(await lp.getAddress(), usdcAmount);
		await (
			await new ethers.Contract(BASE.usdc, ERC20_ABI, lp).approve(testRouterAddress, ethers.MaxUint256)
		).wait();

		await (
			await testRouter
				.connect(lp)
				.addLiquidity(poolKey, TICK_LOWER, TICK_UPPER, ethAmount, usdcAmount, { value: ethAmount })
		).wait();
		expect(await stateView.getLiquidity(poolId)).to.be.greaterThan(0n);

		// ── 5. The routes come from mainnet state; they are uploaded out of band. ──
		const routeReader = new ethers.Contract(BASE.mevxRouter, ROUTE_READ_ABI, ethers.provider);
		for (const direction of [false, true]) {
			const routes = await routeReader.getRoutes(poolId, direction);
			expect(
				routes.length,
				`no routes on-chain for poolId ${poolId} (direction ${direction})`
			).to.be.greaterThan(0);
		}

		// ── 6. The user swap that opens the gap: dump ETH into V4, making ETH cheap there. ──
		const swapAmount = ethAmount / 10n;
		await network.provider.send('hardhat_setBalance', [
			await trader.getAddress(),
			'0x' + (swapAmount * 2n).toString(16),
		]);

		const [, feeGrowth1Before] = await stateView.getFeeGrowthGlobals(poolId);
		const usdcToken = new ethers.Contract(BASE.usdc, ERC20_ABI, ethers.provider);
		const traderUsdcBefore = await usdcToken.balanceOf(await trader.getAddress());

		const swapTx = await testRouter
			.connect(trader)
			.swapExactIn(poolKey, true, swapAmount, { value: swapAmount, gasLimit: 25_000_000 });
		const receipt = await swapTx.wait();
		expect(receipt!.status).to.equal(1);

		const received = (await usdcToken.balanceOf(await trader.getAddress())) - traderUsdcBefore;
		const executionPrice = Number(ethers.formatUnits(received, 6)) / Number(ethers.formatEther(swapAmount));
		console.log(
			`      user swapped:   ${ethers.formatEther(swapAmount)} ETH -> ` +
				`${ethers.formatUnits(received, 6)} USDC (${executionPrice.toFixed(2)} USDC/ETH, ` +
				`${(((executionPrice - ethPriceUsdc) / ethPriceUsdc) * 100).toFixed(2)}% vs V3 mid)`
		);
		expect(received, 'the user received no USDC').to.be.greaterThan(0n);

		for (const line of decodeDiagnostics(receipt!.logs)) console.log(`      router: ${line}`);
		for (const line of describeSwapLegs(receipt!.logs, poolId)) console.log(`      leg: ${line}`);

		// ── 7. The plugin reports what it did with the profit. ──
		const shared = receipt!.logs
			.filter((l) => l.address.toLowerCase() === hookAddress.toLowerCase())
			.map((l) => {
				try {
					return plugin.interface.parseLog({ topics: [...l.topics], data: l.data });
				} catch {
					return null;
				}
			})
			.find((p) => p?.name === 'ProfitShared');

		expect(shared, 'plugin emitted no ProfitShared — the backrun never completed').to.not.equal(undefined);
		const donated: bigint = shared!.args.donatedToLps;
		const sentToDistributor: bigint = shared!.args.sentToDistributor;
		console.log(`      donated to LPs: ${ethers.formatUnits(donated, 6)} USDC`);
		expect(shared!.args.profitToken).to.equal(BASE.usdc);
		expect(donated, 'nothing was donated to the LPs').to.be.greaterThan(0n);
		expect(sentToDistributor, 'lpShareBps is 100%, the distributor must get nothing').to.equal(0n);

		// ── 8. The cycle really closed through the external V3 pool, not just inside V4. ──
		const v3SwapTopic = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
		const v3Leg = receipt!.logs.find(
			(l) => l.address.toLowerCase() === BASE.v3WethUsdc.toLowerCase() && l.topics[0] === v3SwapTopic
		);
		expect(v3Leg, 'the V3 leg of the arbitrage cycle never executed').to.not.equal(undefined);

		// ── 9. The donation actually reached the pool. ──
		const donateLog = receipt!.logs.find(
			(l) =>
				l.address.toLowerCase() === BASE.poolManager.toLowerCase() &&
				l.topics[0] === ethers.id('Donate(bytes32,address,uint256,uint256)') &&
				l.topics[1] === poolId
		);
		expect(donateLog, 'PoolManager emitted no Donate for this pool').to.not.equal(undefined);

		const [, feeGrowth1After] = await stateView.getFeeGrowthGlobals(poolId);
		expect(feeGrowth1After, 'USDC fee growth did not move').to.be.greaterThan(feeGrowth1Before);

		// ── 10. And the LP can actually withdraw it. ──
		const lpUsdcBefore = await usdcToken.balanceOf(await lp.getAddress());
		await (await testRouter.connect(lp).collect(poolKey, TICK_LOWER, TICK_UPPER)).wait();
		const collected = (await usdcToken.balanceOf(await lp.getAddress())) - lpUsdcBefore;
		console.log(`      LP collected:   ${ethers.formatUnits(collected, 6)} USDC`);
		expect(collected, 'the LP received none of the donated profit').to.be.greaterThan(0n);
		// Fee growth is tracked per unit of liquidity and rounds down, so the sole LP recovers
		// the donation minus a few units of dust.
		expect(donated - collected, 'the LP recovered materially less than was donated').to.be.lessThanOrEqual(10n);
	});
});
