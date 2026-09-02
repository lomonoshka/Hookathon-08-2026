import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "wagmi/chains";
import { addresses, demoMevxExecutorAbi, demoMevxRouterAbi } from "@/lib/contracts";
import { buildDemoPoolKey, computePoolId, sortCurrencies } from "@/lib/poolKey";

// Fully enables the arbitrage-capture demo for a visitor's own wizard-deployed pool — not just
// the showcase pool. Two separate on-chain registrations, both owner-gated on contracts a
// visitor's own wallet has no permission to call themselves, so both run server-side with our own
// deployer key (same wallet that owns every demo contract in this repo):
//   1. DemoMevxRouter.setReferencePool — points the pool at our shared, already-liquid "Pool B".
//   2. DemoMevxExecutor.setAuthorizedCaller — lets that specific hook actually trigger a real
//      capture. This used to be a single address (whichever hook was authorized most recently),
//      which meant enabling a visitor's pool would silently break capture on the showcase pool —
//      DemoMevxExecutor.sol now tracks a set of authorized callers instead, so both keep working.

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

// Same fixed vanilla reference pool every showcase hook has pointed at since
// scripts/deploySepolia.ts first created it — fee=1337/tickSpacing=13 deliberately avoids
// colliding with anyone else's standard WETH/USDC pool on Sepolia, no hooks, already has real
// liquidity.
const [poolBCurrency0, poolBCurrency1] = sortCurrencies(addresses.weth, addresses.usdc);
const POOL_B_KEY = {
	currency0: poolBCurrency0,
	currency1: poolBCurrency1,
	fee: 1337,
	tickSpacing: 13,
	hooks: "0x0000000000000000000000000000000000000000" as Address,
} as const;

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

interface RequestBody {
	hookAddress: Address;
}

export async function POST(req: NextRequest) {
	const privateKey = process.env.DEMO_ROUTER_OWNER_PRIVATE_KEY;
	if (!privateKey) {
		return NextResponse.json(
			{ error: "Server is not configured for this yet (missing DEMO_ROUTER_OWNER_PRIVATE_KEY)." },
			{ status: 500 }
		);
	}

	const body = (await req.json()) as RequestBody;
	if (!body.hookAddress || !isAddress(body.hookAddress)) {
		return NextResponse.json({ error: "hookAddress is required and must be a valid address." }, { status: 400 });
	}
	const hookAddress = body.hookAddress;

	try {
		const code = await publicClient.getCode({ address: hookAddress });
		if (!code || code === "0x") {
			return NextResponse.json({ error: "No contract found at that hook address on Sepolia." }, { status: 400 });
		}

		// Server computes the poolId itself from the fixed WETH/USDC pair the wizard always uses —
		// never trusts a client-supplied poolId directly.
		const poolKey = buildDemoPoolKey(hookAddress);
		const poolId = computePoolId(poolKey);

		const [hasReferencePool, isAuthorized] = await Promise.all([
			publicClient.readContract({
				address: addresses.demoMevxRouter,
				abi: demoMevxRouterAbi,
				functionName: "hasReferencePool",
				args: [poolId],
			}),
			publicClient.readContract({
				address: addresses.demoMevxExecutor,
				abi: demoMevxExecutorAbi,
				functionName: "authorizedCallers",
				args: [hookAddress],
			}),
		]);

		if (hasReferencePool && isAuthorized) {
			return NextResponse.json({ poolId, alreadyDone: true });
		}

		const account = privateKeyToAccount(privateKey as Hex);
		const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) });
		const txHashes: Hex[] = [];

		if (!hasReferencePool) {
			const txHash = await walletClient.writeContract({
				address: addresses.demoMevxRouter,
				abi: demoMevxRouterAbi,
				functionName: "setReferencePool",
				args: [poolId, POOL_B_KEY],
			});
			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			if (receipt.status !== "success") {
				return NextResponse.json({ error: "Pool B registration transaction reverted on-chain." }, { status: 500 });
			}
			txHashes.push(txHash);
		}

		if (!isAuthorized) {
			const txHash = await walletClient.writeContract({
				address: addresses.demoMevxExecutor,
				abi: demoMevxExecutorAbi,
				functionName: "setAuthorizedCaller",
				args: [hookAddress, true],
			});
			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			if (receipt.status !== "success") {
				return NextResponse.json({ error: "Authorization transaction reverted on-chain." }, { status: 500 });
			}
			txHashes.push(txHash);
		}

		return NextResponse.json({ poolId, alreadyDone: false, txHashes });
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
