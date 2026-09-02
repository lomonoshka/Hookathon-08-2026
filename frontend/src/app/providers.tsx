"use client";

import { ReactNode, useState } from "react";
import { cookieToInitialState, WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children, cookie }: { children: ReactNode; cookie: string | null }) {
	const [queryClient] = useState(() => new QueryClient());
	const initialState = cookieToInitialState(wagmiConfig, cookie);

	return (
		<WagmiProvider config={wagmiConfig} initialState={initialState}>
			<QueryClientProvider client={queryClient}>
				<RainbowKitProvider theme={darkTheme({ accentColor: "#0ea5e9", accentColorForeground: "#0b0a0e", borderRadius: "large" })}>
					{children}
				</RainbowKitProvider>
			</QueryClientProvider>
		</WagmiProvider>
	);
}
