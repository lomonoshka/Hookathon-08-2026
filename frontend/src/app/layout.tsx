import type { Metadata } from "next";
import { League_Gothic, Inter, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";
import { NavBar } from "@/components/NavBar";

// Same two-typeface system as the main MEV-X brand (BRAND_BOOK.md): League Gothic for
// headlines/big numbers, Inter for everything else. Both are open-source families (not MEV-X
// proprietary assets) — loaded via next/font/google rather than copying their bundled TTFs
// across repos.
const leagueGothic = League_Gothic({
	variable: "--font-league-gothic",
	subsets: ["latin"],
	weight: "400",
});

const inter = Inter({
	variable: "--font-inter",
	subsets: ["latin"],
	weight: ["300", "400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "Homelander Hookathon Demo",
	description: "Deploy and watch a Homelander-protected Uniswap v4 pool on Sepolia",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
	// Read only the raw cookie header here — parsing it into wagmi's initialState needs
	// wagmiConfig, which pulls in RainbowKit's client-only connectorsForWallets(). Importing
	// that into this server component would break the build, so the parsing happens inside the
	// (client) Providers component instead.
	const cookie = (await headers()).get("cookie");

	return (
		<html
			lang="en"
			className={`${leagueGothic.variable} ${inter.variable} ${geistMono.variable} h-full antialiased`}
		>
			<body className="min-h-full flex flex-col text-neutral-100">
				<Providers cookie={cookie}>
					<NavBar />
					<main className="flex-1">{children}</main>
				</Providers>
			</body>
		</html>
	);
}
