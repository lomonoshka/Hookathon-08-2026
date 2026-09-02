import Link from "next/link";

export default function Home() {
	return (
		<div className="px-6 py-12 md:py-16">
			<div className="max-w-[1120px] mx-auto grid lg:grid-cols-[1.05fr_0.95fr] gap-10 lg:gap-14 items-center">
				<div>
					<p className="label-caps mb-6 flex items-center gap-2">
						<span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400" aria-hidden />
						Live on Sepolia
					</p>
					<h1 className="text-[clamp(2.4rem,5.4vw,4.2rem)] leading-[0.98] mb-6 text-white">MEV-X Homelander</h1>
					<p className="text-[1.1rem] leading-[1.6] font-normal text-neutral-400 max-w-[52ch] mb-9 lg:whitespace-nowrap">
						The Uniswap v4 hook that turns MEV into pool yield.
					</p>
					<div className="flex flex-wrap gap-3.5">
						<Link
							href="/dashboard"
							className="px-6 py-3.5 rounded-full bg-white text-neutral-900 font-semibold text-sm hover:bg-white/90 hover:-translate-y-0.5 transition-all"
						>
							View the live pool
						</Link>
					</div>
				</div>

				<div className="glass-panel relative lg:aspect-[1/0.86] flex flex-col items-center justify-center gap-5 px-8 py-10 overflow-hidden">
					<div
						className="pointer-events-none absolute -top-10 -right-10 w-56 h-56 rounded-full bg-sky-500/20 blur-3xl"
						aria-hidden
					/>
					<div className="relative flex flex-col items-center gap-5 w-full max-w-[240px]">
						<div className="w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-3 text-center">
							<p className="label-caps mb-0.5">Swap request</p>
							<p className="text-sm text-neutral-300">arrives at the pool</p>
						</div>
						<div className="h-6 w-px bg-white/15" aria-hidden />
						<div className="w-full rounded-xl border border-sky-400/40 bg-sky-500/[0.07] px-4 py-3.5 text-center shadow-[0_0_30px_-8px_rgba(14,165,233,0.5)]">
							<p className="label-caps text-sky-300 mb-0.5">Homelander hook</p>
							<p className="text-sm text-neutral-200">detects &amp; captures the gap</p>
						</div>
						<div className="h-6 w-px bg-white/15" aria-hidden />
						<div className="w-full rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06] px-4 py-3 text-center">
							<p className="label-caps text-emerald-300 mb-0.5">LPs</p>
							<p className="text-sm text-neutral-300">get the extra yield</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
