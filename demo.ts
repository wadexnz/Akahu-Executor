import { createAppHandler, hostContext, isolatedElicitation } from "apps/host";
import type { ElicitationResponse } from "apps";
import { FormElicitation, type HostRequest } from "apps/contracts";
import { wrap } from "apps/effect";
import app from "./index.js";
import type { Account } from "./schemas.js";
import type { compareInsights } from "./compare.js";

// Runs the real tool through Executor's host boundary, with no network or real credentials.
// Also used by the regression tests; run sequentially because fetch is process-global.
export const demoScope = {
	account_ids: ["acc_everyday", "acc_reserve"],
	baseline: { start: "2026-01-01T00:00:00+13:00", end: "2026-01-31T23:59:59.999+13:00" },
	comparison: { start: "2026-02-01T00:00:00+13:00", end: "2026-02-28T23:59:59.999+13:00" },
};
export const demoAnswer = {
	action: "accept",
	content: {
		account_ids: demoScope.account_ids,
		baseline_start: demoScope.baseline.start, baseline_end: demoScope.baseline.end,
		comparison_start: demoScope.comparison.start, comparison_end: demoScope.comparison.end,
	},
} satisfies ElicitationResponse;

export async function syntheticReview(
	input: Partial<Parameters<typeof compareInsights>[1]> = {},
	respond?: (form: FormElicitation) => ElicitationResponse,
	options: { noEligibleAccounts?: boolean; tool?: string } = {},
) {
	const handle = createAppHandler(app);
	const request = (body: HostRequest) => new Request("https://app.test", { method: "POST", body: JSON.stringify(body) });
	const requirements = await (await handle(request({ operation: "requirements" }), hostContext({ app: {} }))).json();
	const accountsContext = hostContext({ app: {}, user: { akahu: {
		id: "acc_synthetic", provider: requirements.value.accounts.user.akahu.definition,
		method: "personalApp", fields: { "App ID Token": "synthetic-app", "User Access Token": "synthetic-user" },
	} } });
	const questions: FormElicitation[] = [];
	const context = {
		...accountsContext,
		...(respond && { elicitation: isolatedElicitation(async request => {
			const form = wrap(FormElicitation, false).parse(request);
			questions.push(form);
			return { ok: true, response: respond(form) };
		}, new AbortController()) }),
	};
	const accounts: Account[] = [
		{ _id: "acc_everyday", name: "Everyday", balance: { currency: "NZD", current: 0 }, attributes: ["TRANSACTIONS"] },
		{ _id: "acc_reserve", name: "Reserve (feed fails in February)", balance: { currency: "NZD", current: 0 }, attributes: ["TRANSACTIONS"] },
		{ _id: "acc_foreign", name: "USD", balance: { currency: "USD", current: 0 }, attributes: ["TRANSACTIONS"] },
		{ _id: "acc_unknown", name: "Unknown currency", attributes: ["TRANSACTIONS"] },
		{ _id: "acc_nofeed", name: "No history feed", balance: { currency: "NZD", current: 0 }, attributes: [] },
	].map(a => ({ ...a, type: "CHECKING", status: "ACTIVE", connection: { name: "Synthetic Bank" } }));
	const transactionRequests: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== "https://api.akahu.io" || (init?.method ?? "GET") !== "GET") throw new Error("Synthetic demo refuses this request");
		if (url.pathname === "/v1/accounts") return Response.json({ items: options.noEligibleAccounts ? accounts.slice(2) : accounts });
		transactionRequests.push(url.pathname);
		const match = /^\/v1\/accounts\/(acc_everyday|acc_reserve)\/transactions$/.exec(url.pathname);
		if (!match) throw new Error("Synthetic demo refuses this path");
		const account = match[1]!;
		const baseline = url.searchParams.get("end") === demoScope.baseline.end;
		const range = baseline ? demoScope.baseline : demoScope.comparison;
		const start = Date.parse(url.searchParams.get("start") ?? ""), end = Date.parse(url.searchParams.get("end") ?? "");
		if (url.searchParams.get("end") !== range.end) throw new Error("Unexpected synthetic date range");
		if (account === "acc_reserve" && !baseline) return Response.json({}, { status: 503 });
		const amounts = account === "acc_reserve" ? [999] : baseline ? [20, 30, 50] : [80, 40, 150];
		// Like Akahu: start is exclusive, end inclusive. Rows sit exactly on the period start.
		return Response.json({ items: amounts.map((amount, i) => ({
			_id: `trans_${baseline ? "jan" : "feb"}${account === "acc_reserve" ? "reserve" : i + 1}`,
			_account: account, date: range.start, amount: -amount,
			type: !baseline && i === 2 ? "TRANSFER" : "DEBIT",
			description: !baseline && i === 2 ? "Synthetic transfer to savings" : "Synthetic purchase",
			category: { name: baseline || i === 0 ? "Groceries" : i === 1 ? "Dining" : "Transfers" },
			merchant: { name: baseline || i === 0 ? "Fixture Market" : i === 1 ? "Fixture Cafe" : "Fixture Savings" },
		})).filter(t => Date.parse(t.date) > start && Date.parse(t.date) <= end), cursor: { next: null } });
	}, { preconnect: () => {} });
	try {
		const result = await (await handle(request({ operation: "call", tool: options.tool ?? "insights.reviewSpending", input }), context)).json();
		return { questions, transactionRequests, result };
	} finally {
		globalThis.fetch = originalFetch;
	}
}

if (import.meta.main) {
	const run = await syntheticReview({}, () => demoAnswer);
	console.log(JSON.stringify({
		label: "Synthetic local host demonstration; not a live MCP session or model-generated answer",
		prompt: "Review my spending. Ask me which accounts and periods to compare.",
		tool: "insights.reviewSpending", input: {}, questions: run.questions, answer: demoAnswer, result: run.result,
	}, null, 2));
	if (!run.result.ok) process.exitCode = 1;
}
