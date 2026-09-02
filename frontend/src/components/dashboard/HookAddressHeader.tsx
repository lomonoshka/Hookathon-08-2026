"use client";

import { useState } from "react";
import type { Address } from "viem";

export function HookAddressHeader({ hookAddress, isDefault }: { hookAddress: Address; isDefault: boolean }) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(hookAddress);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard API unavailable (e.g. insecure context) — the full address is already
			// shown below for manual copy, so just no-op.
		}
	}

	return (
		<div>
			<p className="label-caps mb-1">{isDefault ? "Showcase demo pool" : "Pool hook"}</p>
			<div className="flex flex-wrap items-center gap-2">
				<h1 className="text-xl sm:text-2xl font-mono break-all text-white">{hookAddress}</h1>
				<button
					type="button"
					onClick={copy}
					className="shrink-0 text-xs px-2 py-1 rounded border border-white/15 hover:border-white/35 text-neutral-300 transition-colors"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
		</div>
	);
}
