// One real transaction from the pool above, picked out and verified against its actual
// Transfer logs on Base mainnet (not just the block explorer's summary) — every USDC amount
// here matches an on-chain Transfer event in the tx, not a rounded/approximate figure.
const TX_HASH = "0xf3baa5a7dd6ceddb6d494b0b879d322840af8c85910ae8ecb8269c5cda0f9749";
const RECIPIENT_A = "0x3cd1615b14036403914db75588eda9dc65f01d0d";
const RECIPIENT_B = "0x228148889505f14602458969e36f8546cd0f0354";

const blockscoutTx = `https://base.blockscout.com/tx/${TX_HASH}`;
const blockscoutAddress = (addr: string) => `https://base.blockscout.com/address/${addr}`;
const sentioTx = `https://app.sentio.xyz/tx/8453/${TX_HASH}?nav=s`;

export function ExampleCapture() {
	return (
		<section className="glass-panel p-5 space-y-4">
			<div className="flex items-center justify-between flex-wrap gap-2">
				<h2 className="label-caps">Example: a real capture</h2>
				<div className="flex items-center gap-4">
					<a
						href={sentioTx}
						target="_blank"
						rel="noreferrer"
						className="text-xs text-neutral-400 hover:text-neutral-200 underline underline-offset-2"
					>
						See the flow visualized on Sentio →
					</a>
					<a
						href={blockscoutTx}
						target="_blank"
						rel="noreferrer"
						className="text-xs text-neutral-400 hover:text-neutral-200 underline underline-offset-2"
					>
						View transaction on Blockscout →
					</a>
				</div>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
				<div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
					<div className="label-caps mb-1">Swap volume</div>
					<div className="stat-number text-2xl">$100</div>
				</div>
				<div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06] p-3">
					<div className="label-caps text-emerald-300 mb-1">MEV captured</div>
					<div className="stat-number text-2xl text-emerald-300">0.063866 USDC</div>
				</div>
				<div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
					<div className="label-caps mb-1">Where it went</div>
					<div className="text-sm text-neutral-300 space-y-0.5 mt-1">
						<div>
							<a
								href={blockscoutAddress(RECIPIENT_A)}
								target="_blank"
								rel="noreferrer"
								className="font-mono text-xs text-neutral-400 hover:text-neutral-200"
							>
								{RECIPIENT_A.slice(0, 8)}…
							</a>{" "}
							— 0.031933
						</div>
						<div>
							<a
								href={blockscoutAddress(RECIPIENT_B)}
								target="_blank"
								rel="noreferrer"
								className="font-mono text-xs text-neutral-400 hover:text-neutral-200"
							>
								{RECIPIENT_B.slice(0, 8)}…
							</a>{" "}
							— 0.031933
						</div>
					</div>
				</div>
			</div>

			<p className="text-xs text-neutral-600">
				A $100 swap through this pool got a real 0.063866 USDC MEV capture, split 50/50 between the two
				recipients above — verified directly against the transaction&apos;s own Transfer events, not read off
				a summary.
			</p>
		</section>
	);
}
