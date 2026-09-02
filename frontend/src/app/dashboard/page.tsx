import { Suspense } from "react";
import { DashboardContent } from "@/components/dashboard/DashboardContent";

function DashboardFallback() {
	return (
		<div className="max-w-5xl mx-auto px-6 py-16">
			<p className="text-neutral-400">Loading pool dashboard…</p>
		</div>
	);
}

export default function DashboardPage() {
	return (
		<Suspense fallback={<DashboardFallback />}>
			<DashboardContent />
		</Suspense>
	);
}
