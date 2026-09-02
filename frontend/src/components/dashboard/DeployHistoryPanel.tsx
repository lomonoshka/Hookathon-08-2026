"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { reconstructDeployHistory, type DeployHistory } from "@/lib/deployHistory";

const etherscanTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
const etherscanAddress = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

/**
 * The deploy wizard's own step-by-step record (addresses, tx hashes) only ever lives in the
 * localStorage of the browser that ran it — anyone else (a guest, or the owner in a different
 * session) sees a blank wizard even though the pool is real and live. This rebuilds that same
 * trail from on-chain data alone, so it's visible to everyone regardless of who deployed it or
 * where.
 */
export function DeployHistoryPanel({ hookAddress }: { hookAddress: `0x${string}` | null }) {
	const publicClient = usePublicClient();
	const [history, setHistory] = useState<DeployHistory | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!publicClient || !hookAddress) {
			setHistory(hookAddress ? undefined : null);
			return;
		}
		let cancelled = false;
		setHistory(undefined);
		setError(null);
		reconstructDeployHistory(publicClient, hookAddress)
			.then((result) => {
				if (!cancelled) setHistory(result);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't rebuild the deploy history.");
			});
		return () => {
			cancelled = true;
		};
	}, [publicClient, hookAddress]);

	if (!hookAddress) return null;

	return (
		<section className="glass-panel p-6 flex flex-col gap-3">
			<h2 className="label-caps">Deployment history (from on-chain data)</h2>
			<p className="text-xs text-neutral-500">
				Rebuilt directly from Sepolia — every address and transaction below is real and independently
				checkable, whether or not you were the one who deployed it.
			</p>

			{error && <p className="text-xs text-red-400 break-words">{error}</p>}

			{history === undefined && !error && <p className="text-xs text-neutral-500">Rebuilding from on-chain data…</p>}

			{history && (
				<ul className="flex flex-col gap-2">
					{history.steps.map((step) => (
						<li key={step.label} className="text-xs text-neutral-400 truncate">
							<span className="text-neutral-300">{step.label}:</span>{" "}
							{step.address && (
								<>
									<a
										href={etherscanAddress(step.address)}
										target="_blank"
										rel="noreferrer"
										title={step.address}
										className="text-neutral-300 hover:underline font-mono"
									>
										{short(step.address)}
									</a>
									{step.txHash && " · "}
								</>
							)}
							{step.txHash ? (
								<a
									href={etherscanTx(step.txHash)}
									target="_blank"
									rel="noreferrer"
									title={step.txHash}
									className="text-neutral-300 hover:underline font-mono"
								>
									{step.address ? "tx" : short(step.txHash)}
								</a>
							) : (
								!step.address && <span className="text-neutral-600">not found in the last ~40k blocks</span>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
