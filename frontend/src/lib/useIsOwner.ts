"use client";

import { useAccount } from "wagmi";
import { OWNER_ADDRESS } from "./contracts";

/** True only when the connected wallet is the project owner's — the one wallet allowed to
 * deploy a pool or drive any interactive control on the showcase dashboard. Everyone else
 * (including a disconnected visitor) gets a read-only view. */
export function useIsOwner(): boolean {
	const { address } = useAccount();
	return !!address && address.toLowerCase() === OWNER_ADDRESS.toLowerCase();
}
