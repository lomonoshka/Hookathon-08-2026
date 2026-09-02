import type { Address, Hex, PublicClient } from "viem";
import { addresses, hookAbi as hookFullAbi, poolManagerLifecycleEventAbi } from "@/lib/contracts";
import { buildDemoPoolKey, computePoolId } from "@/lib/poolKey";

// Written out as its own literal (matching the `ChainlinkPmmConfig` struct in hookArtifact.ts)
// rather than looked up via `hookFullAbi.find(...)` — TS narrows that lookup's result to the
// ABI's function entries only and rejects the "event" check as unreachable, for reasons that
// didn't seem worth chasing further.
const PMM_CONFIG_SET_EVENT = {
	type: "event",
	anonymous: false,
	name: "PmmConfigSet",
	inputs: [
		{
			indexed: false,
			name: "config",
			type: "tuple",
			components: [
				{ name: "token0UsdFeed", type: "address" },
				{ name: "token1UsdFeed", type: "address" },
				{ name: "token0FeedDecimals", type: "uint8" },
				{ name: "token1FeedDecimals", type: "uint8" },
				{ name: "baseFee", type: "uint24" },
				{ name: "maxFee", type: "uint24" },
				{ name: "feePerDeviationBps", type: "uint24" },
				{ name: "neutralThresholdBps", type: "uint16" },
				{ name: "maxOracleAge", type: "uint32" },
				{ name: "observationWindow", type: "uint32" },
				{ name: "minObservationAge", type: "uint32" },
				{ name: "maxSpotToReferenceDeviationBps", type: "uint16" },
				{ name: "maxLimitToSpotDeviationBps", type: "uint16" },
				{ name: "trackedTokenIsToken0", type: "bool" },
				{ name: "enabled", type: "bool" },
			],
		},
	],
} as const;

// Reconstructs the deploy wizard's own record — the exact addresses/tx hashes shown on /deploy's
// "Pool live" panel while the wizard runs — purely from on-chain data, given only a hook address.
// The wizard's own record only ever lives in the browser that ran it (localStorage); this is what
// lets anyone (owner in a fresh session, or any visitor) see the same trail.
//
// Every step here is a public read — no wallet needed — but MockV3Aggregator's `updateAnswer`
// never actually emits `AnswerUpdated` (checked directly against @chainlink/contracts' mock
// source), so the two price feeds can't be found via an event the way everything else can. They're
// instead located by bisecting `eth_getCode` between the hook's own deploy block and the pool's
// init block (the wizard always deploys both feeds in that narrow window) to find each feed's
// first block with code, then scanning that block's transactions for the one whose receipt
// `contractAddress` matches.

const LOOKBACK_BLOCKS = 40_000n;

export interface DeployHistoryStep {
	label: string;
	address?: Address;
	txHash?: Hex;
}

export interface DeployHistory {
	hookAddress: Address;
	poolId: Hex;
	steps: DeployHistoryStep[];
}

async function findDeployBlock(client: PublicClient, address: Address, lo: bigint, hi: bigint): Promise<bigint> {
	// Invariant: no code at `lo`, code present at `hi`.
	while (lo + 1n < hi) {
		const mid = (lo + hi) / 2n;
		const code = await client.getBytecode({ address, blockNumber: mid });
		if (!code || code === "0x") lo = mid;
		else hi = mid;
	}
	return hi;
}

async function findContractCreationTx(client: PublicClient, blockNumber: bigint, targetAddress: Address): Promise<Hex | undefined> {
	const block = await client.getBlock({ blockNumber, includeTransactions: true });
	for (const tx of block.transactions) {
		if (tx.to !== null) continue;
		const receipt = await client.getTransactionReceipt({ hash: tx.hash });
		if (receipt.contractAddress?.toLowerCase() === targetAddress.toLowerCase()) return tx.hash;
	}
	return undefined;
}

export async function reconstructDeployHistory(client: PublicClient, hookAddress: Address): Promise<DeployHistory | null> {
	const code = await client.getBytecode({ address: hookAddress });
	if (!code || code === "0x") return null;

	const latest = await client.getBlockNumber();
	const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

	const hookContract = { address: hookAddress, abi: hookFullAbi } as const;
	const pmmConfig = (await client.readContract({ ...hookContract, functionName: "pmmConfig" })) as readonly [Address, Address, ...unknown[]];
	const [token0Feed, token1Feed] = pmmConfig;

	const poolKey = buildDemoPoolKey(hookAddress);
	const poolId = computePoolId(poolKey);

	const [ownershipLogs, configLogs, initLogs, liquidityLogs] = await Promise.all([
		client.getLogs({
			address: hookAddress,
			event: {
				type: "event",
				name: "OwnershipTransferred",
				inputs: [
					{ indexed: true, name: "previousOwner", type: "address" },
					{ indexed: true, name: "newOwner", type: "address" },
				],
			},
			fromBlock,
			toBlock: "latest",
		}),
		client.getLogs({
			address: hookAddress,
			event: PMM_CONFIG_SET_EVENT,
			fromBlock,
			toBlock: "latest",
		}),
		client.getLogs({
			address: addresses.poolManager,
			event: poolManagerLifecycleEventAbi[0],
			args: { id: poolId },
			fromBlock,
			toBlock: "latest",
		}),
		client.getLogs({
			address: addresses.poolManager,
			event: poolManagerLifecycleEventAbi[1],
			args: { id: poolId },
			fromBlock,
			toBlock: "latest",
		}),
	]);

	const hookDeployLog = ownershipLogs[0];
	const initLog = initLogs[0];

	// Feeds must exist by the time the pool is initialized (setPmmConfig requires them), and can't
	// have existed before the hook itself — bisect that narrow window instead of the full lookback.
	const upperBound = initLog?.blockNumber ?? latest;
	const lowerBound = hookDeployLog?.blockNumber ?? fromBlock;

	let feed0TxHash: Hex | undefined;
	let feed1TxHash: Hex | undefined;
	if (lowerBound !== undefined && upperBound !== undefined) {
		const [feed0Block, feed1Block] = await Promise.all([
			findDeployBlock(client, token0Feed, lowerBound, upperBound),
			findDeployBlock(client, token1Feed, lowerBound, upperBound),
		]);
		[feed0TxHash, feed1TxHash] = await Promise.all([
			findContractCreationTx(client, feed0Block, token0Feed),
			findContractCreationTx(client, feed1Block, token1Feed),
		]);
	}

	const steps: DeployHistoryStep[] = [
		{ label: "Deploy hook contract", address: hookAddress, txHash: hookDeployLog?.transactionHash },
		{ label: "Deploy USDC price feed", address: token0Feed, txHash: feed0TxHash },
		{ label: "Deploy WETH price feed", address: token1Feed, txHash: feed1TxHash },
		{ label: "Configure dynamic fee", txHash: configLogs[0]?.transactionHash },
		{ label: "Initialize pool", txHash: initLog?.transactionHash },
		{ label: "Add liquidity", txHash: liquidityLogs[0]?.transactionHash },
	];

	return { hookAddress, poolId, steps };
}
