import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, encodeAbiParameters, http, type Address, type Hex } from "viem";
import { sepolia } from "wagmi/chains";
import { HookFlags, mineHookSalt } from "@/lib/hookMiner";

const publicClient = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });

// The well-known deterministic CREATE2 factory (Arachnid/deterministic-deployment-proxy),
// deployed at the same address on virtually every EVM chain including Sepolia. Verified
// on-chain before use — see docs/sepolia-addresses.md.
export const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

const HOOK_FLAGS = HookFlags.AFTER_INITIALIZE | HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;

interface MineRequestBody {
	/** Creation bytecode of HomelanderUniV4PluginChainlinkPmm (0x-prefixed hex, no constructor args appended). */
	bytecode: Hex;
	/** Constructor args, in order: poolManager, owner, mevxRouter, mevxExecutor, profitDistributor, dynamicFee. */
	constructorArgs: {
		poolManager: Address;
		owner: Address;
		mevxRouter: Address;
		mevxExecutor: Address;
		profitDistributor: Address;
		dynamicFee: string; // uint24, as a decimal string (JSON can't carry bigint)
	};
}

export async function POST(req: NextRequest) {
	const body = (await req.json()) as MineRequestBody;

	const encodedArgs = encodeAbiParameters(
		[
			{ type: "address" },
			{ type: "address" },
			{ type: "address" },
			{ type: "address" },
			{ type: "address" },
			{ type: "uint24" },
		],
		[
			body.constructorArgs.poolManager,
			body.constructorArgs.owner,
			body.constructorArgs.mevxRouter,
			body.constructorArgs.mevxExecutor,
			body.constructorArgs.profitDistributor,
			Number(body.constructorArgs.dynamicFee),
		]
	);

	const initCode = (body.bytecode + encodedArgs.slice(2)) as Hex;

	try {
		// Re-mine (from a fresh random start each time) if the predicted address already has
		// code — belt-and-suspenders on top of mineHookSalt's random starting point, in case an
		// earlier deploy (e.g. our own demo pool, same owner+pair) happens to have landed there.
		let salt: Hex, hookAddress: Address;
		for (let attempt = 0; ; attempt++) {
			({ salt, hookAddress } = mineHookSalt(CREATE2_FACTORY, HOOK_FLAGS, initCode));
			const existingCode = await publicClient.getCode({ address: hookAddress });
			if (!existingCode || existingCode === "0x") break;
			if (attempt >= 9) {
				return NextResponse.json(
					{ error: "Could not find a free hook address after multiple attempts — please retry." },
					{ status: 500 }
				);
			}
		}
		// The canonical factory takes raw calldata = salt ++ initCode (no function selector).
		const deployCalldata = (salt + initCode.slice(2)) as Hex;

		return NextResponse.json({
			salt,
			hookAddress,
			create2Factory: CREATE2_FACTORY,
			deployTx: { to: CREATE2_FACTORY, data: deployCalldata },
		});
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
