import { getTransactionCount } from "wagmi/actions";
import type { Address } from "viem";
import { wagmiConfig } from "@/lib/wagmi";

// Some wallet extensions cache their own "next nonce" per-account and don't always refetch it
// fresh before sending — after a burst of transactions from the same account in a short window
// (exactly what this app's deploy wizard + dashboard demo buttons do), that cache can drift behind
// the chain's real confirmed count, and the wallet then submits a stale nonce and fails with
// "Nonce provided for the transaction is lower than the current nonce of the account." Fetching
// the real next nonce ourselves and passing it explicitly overrides the wallet's own guess (wallets
// honor an explicitly-provided nonce), sidestepping that cache entirely rather than depending on
// the person clearing their wallet's activity/nonce cache by hand.
export async function getFreshNonce(address: Address): Promise<number> {
	return getTransactionCount(wagmiConfig, { address, blockTag: "pending" });
}
