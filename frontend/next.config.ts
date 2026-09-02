import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Dev-mode only: Next.js blocks cross-origin requests to its own HMR/static-chunk endpoints
	// by default, which silently breaks client-side hydration (e.g. the wallet connect button
	// never renders) when the app is viewed through a tunnel instead of localhost directly.
	// Wildcarded so this survives the tunnel URL changing on restart.
	allowedDevOrigins: ["*.trycloudflare.com", "*.loca.lt"],
	// This app lives in a subdirectory of the Hardhat project (which has its own yarn.lock) —
	// pin the workspace root explicitly so Next.js doesn't try to infer it.
	turbopack: {
		root: __dirname,
		// @coinbase/cdp-sdk (pulled in transitively by @wagmi/connectors' Coinbase Smart Wallet
		// connector, which RainbowKit's package re-exports even though we don't use it) has an
		// optional Solana/x402 dynamic-import code path that doesn't resolve. We never exercise
		// that path (no coinbaseWallet connector in our wallet list), so it's safe to stub these
		// modules out entirely rather than let the bundler fail trying to resolve them.
		resolveAlias: {
			// @base-org/account is only ever reached via a runtime-only `await import(...)`
			// inside @wagmi/connectors' Coinbase Smart Wallet connector, which we never
			// instantiate (excluded from our wallet list). Aliasing the whole package (rather
			// than chasing its broken @coinbase/cdp-sdk → @x402/* → @solana/kit dependency
			// chain module-by-module) stops the bundler from tracing into it at all.
			"@base-org/account": "./src/lib/empty-module.ts",
		},
	},
};

export default nextConfig;
