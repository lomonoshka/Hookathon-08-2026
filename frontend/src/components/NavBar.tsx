"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";

export function NavBar() {
	return (
		<header className="sticky top-0 z-20 flex items-center justify-between gap-4 px-6 py-[18px] border-b border-white/10 bg-[#0b0a0e]/55 backdrop-blur-[10px] flex-wrap">
			<div className="flex items-center gap-8 flex-wrap">
				<Link href="/" className="font-display text-xl tracking-wide text-white">
					MEV-X Homelander
				</Link>
				<nav className="flex items-center gap-5 flex-wrap">
					<Link
						href="/deploy"
						className="text-[11px] font-semibold uppercase tracking-[0.2em] text-neutral-400 hover:text-white transition-colors"
					>
						Deploy a pool
					</Link>
					<Link
						href="/dashboard"
						className="text-[11px] font-semibold uppercase tracking-[0.2em] text-neutral-400 hover:text-white transition-colors"
					>
						Dashboard
					</Link>
					<Link
						href="/mainnet"
						className="text-[11px] font-semibold uppercase tracking-[0.2em] text-neutral-400 hover:text-white transition-colors"
					>
						Mainnet activity
					</Link>
				</nav>
			</div>
			<ConnectButton />
		</header>
	);
}
