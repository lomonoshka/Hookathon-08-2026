import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, isAddress, type Address } from "viem";
import { sepolia } from "wagmi/chains";
import { OWNER_ADDRESS } from "@/lib/contracts";

// Persists which pool `/dashboard` shows by default, so a real wizard deploy from the owner's
// wallet becomes everyone's view automatically — no manual contracts.ts edit + redeploy needed.
// `data/` (gitignored) sits outside `src/`, which the redeploy process only ever rsyncs over —
// and on the VPS specifically it's a bind-mounted host volume (see the deploy process), so this
// file survives every future code redeploy, which recreates the container from a fresh image.
const DATA_FILE = path.join(process.cwd(), "data", "official-pool.json");

const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

const ownableAbi = [
	{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

interface OfficialPoolState {
	hookAddress: Address | null;
	updatedAt: string | null;
}

async function readState(): Promise<OfficialPoolState> {
	try {
		const raw = await readFile(DATA_FILE, "utf8");
		return JSON.parse(raw) as OfficialPoolState;
	} catch {
		// File doesn't exist yet (first run) or isn't valid JSON — no official pool set.
		return { hookAddress: null, updatedAt: null };
	}
}

export async function GET() {
	const state = await readState();
	return NextResponse.json(state);
}

interface RequestBody {
	hookAddress: Address;
}

export async function POST(req: NextRequest) {
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

		// The only real proof this hook came from a legitimate owner deploy: it's an Ownable2Step
		// contract, and the wizard always passes the connected (owner-gated) wallet as its owner_
		// constructor arg — so a hook whose owner() isn't OWNER_ADDRESS never gets accepted here,
		// no signature flow needed.
		const onChainOwner = await publicClient.readContract({
			address: hookAddress,
			abi: ownableAbi,
			functionName: "owner",
		});
		if (onChainOwner.toLowerCase() !== OWNER_ADDRESS.toLowerCase()) {
			return NextResponse.json({ error: "This hook isn't owned by the project owner's wallet." }, { status: 403 });
		}

		const state: OfficialPoolState = { hookAddress, updatedAt: new Date().toISOString() };
		await mkdir(path.dirname(DATA_FILE), { recursive: true });
		await writeFile(DATA_FILE, JSON.stringify(state, null, 2));

		return NextResponse.json(state);
	} catch (err) {
		return NextResponse.json({ error: (err as Error).message }, { status: 500 });
	}
}
