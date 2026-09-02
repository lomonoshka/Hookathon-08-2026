import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, walletConnectWallet, rainbowWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, createStorage, cookieStorage, http } from "wagmi";
import { sepolia } from "wagmi/chains";

// Demo WalletConnect projectId placeholder — MetaMask/injected wallets work fine without a
// real one; get your own at https://cloud.walletconnect.com before using WalletConnect-based
// wallets in production.
const projectId = "00000000000000000000000000000000";

// Deliberately a curated wallet list (not RainbowKit's getDefaultConfig full set) — the
// default set pulls in @coinbase/cdp-sdk's optional Solana/x402 payment code path, which
// fails to bundle under Next.js's build (unresolvable dynamic import). Excluding Coinbase
// Smart Wallet sidesteps it; MetaMask/injected/WalletConnect cover the demo just fine.
const connectors = connectorsForWallets(
	[
		{
			groupName: "Recommended",
			wallets: [metaMaskWallet, walletConnectWallet, injectedWallet, rainbowWallet],
		},
	],
	{ appName: "Homelander Hookathon Demo", projectId }
);

export const wagmiConfig = createConfig({
	connectors,
	chains: [sepolia],
	transports: {
		// Explicit, known-reliable RPC — wagmi/viem's default Sepolia RPC (used when no URL is
		// given to http()) can be slow/rate-limited, which made waitForTransactionReceipt polling
		// appear to hang indefinitely even after a transaction had actually confirmed.
		[sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
	},
	ssr: true,
	// cookieStorage (not the default plain localStorage) is required for `ssr: true` to actually
	// auto-reconnect on load — without it, wagmi has nothing to hydrate from on the very first
	// render and falls back to "disconnected", which is why a page refresh was asking to
	// reconnect the wallet every time instead of picking the prior session back up.
	storage: createStorage({ storage: cookieStorage }),
});
