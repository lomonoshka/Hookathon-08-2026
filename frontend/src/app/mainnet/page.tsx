import Link from "next/link";
import { MainnetPoolStats } from "@/components/mainnet/MainnetPoolStats";
import { ExampleCapture } from "@/components/mainnet/ExampleCapture";

export default function MainnetPage() {
	return (
		<div className="max-w-5xl mx-auto px-6 py-10 space-y-6">
			<div className="flex items-center justify-between flex-wrap gap-3">
				<h1 className="text-2xl text-white">Real Homelander activity on Base mainnet</h1>
				<Link href="/dashboard" className="text-sm text-neutral-400 hover:text-neutral-200">
					← Testnet dashboard (Sepolia)
				</Link>
			</div>
			<p className="text-sm text-neutral-500">A pool running the Homelander v1 hook, live on Base.</p>
			<MainnetPoolStats />
			<ExampleCapture />
		</div>
	);
}
