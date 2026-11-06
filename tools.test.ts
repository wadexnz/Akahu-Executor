import { expect, spyOn, test } from "bun:test";
import { createAppHandler, hostContext } from "apps/host";
import type { HostRequest } from "apps/contracts";
import app from "./index.js";
import type { Account } from "./akahu.js";
import { demoAnswer, demoScope, syntheticReview } from "./demo.js";

test("transaction tools keep currencies separate through the public host boundary", async () => {
	const handle = createAppHandler(app);
	const request = (body: HostRequest) => new Request("https://app.test", {
		method: "POST", body: JSON.stringify(body),
	});
	const declaration = await (await handle(request({ operation: "requirements" }), hostContext({ app: {} }))).json();
	const credentials = declaration.value.accounts.user.akahu.definition.auth.personalApp.fields;
	expect(Object.keys(credentials.properties)).toEqual(["App ID Token", "User Access Token"]);
	expect(credentials.required).toEqual(["App ID Token", "User Access Token"]);
	const context = hostContext({ app: {}, user: { akahu: {
		id: "acc_synthetic",
		provider: declaration.value.accounts.user.akahu.definition,
		method: "personalApp",
		fields: { "App ID Token": "synthetic-app", "User Access Token": "synthetic-user" },
	} } });
	const row = (id: string, account: string, amount: number) => ({
		_id: id, _account: account, amount, date: "2026-10-01T00:00:00Z",
		description: "Synthetic purchase", type: amount < 0 ? "DEBIT" : "CREDIT",
		category: { name: "Groceries" },
	});
	const rows = [
		row("trans_nzd", "acc_nzd", -100),
		row("trans_usd", "acc_usd", -50),
		row("trans_nzd2", "acc_nzd2", -25.5),
		row("trans_credit", "acc_nzd", 7.25),
		row("trans_unknown", "acc_unknown", -999),
		row("trans_missing", "acc_missing", -888),
	];
	const accounts: Account[] = [
		{ _id: "acc_nzd", balance: { currency: "NZD", current: 0 } },
		{ _id: "acc_nzd2", balance: { currency: "NZD", current: 0 } },
		{ _id: "acc_usd", balance: { currency: "USD", current: 0 } },
		{ _id: "acc_unknown" },
	].map(a => ({ ...a, name: a._id, type: "CHECKING", status: "ACTIVE", attributes: ["TRANSACTIONS"], connection: { name: "Synthetic Bank" } }));
	let accountsFail = false;
	const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== "https://api.akahu.io") throw new Error("Unexpected origin");
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		expect(headers.get("x-akahu-id")).toBe("synthetic-app");
		expect(headers.get("authorization")).toBe("Bearer synthetic-user");
		if (url.pathname === "/v1/accounts") return Response.json(accountsFail ? {} : {
			items: accounts,
		}, { status: accountsFail ? 503 : 200 });
		if (url.pathname !== "/v1/transactions" && url.pathname !== "/v1/accounts/acc_usd/transactions")
			throw new Error("Unexpected path");
		const scoped = url.pathname.includes("/accounts/") ? rows.filter(t => t._account === "acc_usd") : rows;
		const next = url.searchParams.has("cursor");
		return Response.json({ items: next ? scoped.slice(2) : scoped.slice(0, 2), cursor: { next: next ? null : "page2" } });
	}, { preconnect: () => {} }));
	const call = async (tool: string, input = {}) => {
		const result = await (await handle(request({ operation: "call", tool, input }), context)).json();
		expect(result.ok).toBe(true);
		return result.value;
	};
	try {
		const transactions = await call("getTransactions");
		expect(transactions.count).toBe(6);
		expect(transactions.truncated).toBe(false);
		expect(transactions).not.toHaveProperty("net_total");
		expect(transactions.currencies).toEqual([
			{ currency: "NZD", net_total: -118.25 },
			{ currency: "USD", net_total: -50 },
		]);
		expect(transactions.unknown_currency_transaction_ids).toEqual(["trans_unknown", "trans_missing"]);
		expect(transactions.transactions.map((t: { id: string }) => t.id)).toEqual(rows.map(t => t._id));

		const limited = await call("getTransactions", { limit: 3 });
		expect(limited.truncated).toBe(true);
		expect(limited.currencies).toEqual([
			{ currency: "NZD", net_total: -125.5 }, { currency: "USD", net_total: -50 },
		]);
		expect(limited.unknown_currency_transaction_ids).toEqual([]);

		const summary = await call("getTransactionSummary");
		expect(summary.transaction_count).toBe(6);
		expect(summary).not.toHaveProperty("total_spending");
		expect(summary.currencies).toEqual([
			{ currency: "NZD", transaction_count: 3, total_spending: -125.5, total_income: 7.25,
				groups: [{ name: "Groceries", count: 3, total: -118.25 }] },
			{ currency: "USD", transaction_count: 1, total_spending: -50, total_income: 0,
				groups: [{ name: "Groceries", count: 1, total: -50 }] },
		]);
		expect(summary.unknown_currency_transaction_ids).toEqual(["trans_unknown", "trans_missing"]);
		const spending = await call("getTransactionSummary", { spending_only: true });
		expect(spending.transaction_count).toBe(5);
		expect(spending.currencies).toEqual([
			{ currency: "NZD", transaction_count: 2, total_spending: -125.5, total_income: 0,
				groups: [{ name: "Groceries", count: 2, total: -125.5 }] },
			{ currency: "USD", transaction_count: 1, total_spending: -50, total_income: 0,
				groups: [{ name: "Groceries", count: 1, total: -50 }] },
		]);
		expect(spending.unknown_currency_transaction_ids).toEqual(["trans_unknown", "trans_missing"]);

		const scoped = await call("getTransactionSummary", { account_id: "acc_usd", spending_only: true, group_by: "type" });
		expect(scoped.currencies).toEqual([
			{ currency: "USD", transaction_count: 1, total_spending: -50, total_income: 0,
				groups: [{ name: "DEBIT", count: 1, total: -50 }] },
		]);
		expect(scoped.unknown_currency_transaction_ids).toEqual([]);

		accountsFail = true;
		for (const tool of ["getTransactions", "getTransactionSummary"]) {
			const failed = await (await handle(request({ operation: "call", tool, input: {} }), context)).json();
			expect(failed.ok).toBe(false);
		}
	} finally {
		network.mockRestore();
	}
});

test("guided review returns evidenced partial results, not zero for a failed account", async () => {
	const { result, questions } = await syntheticReview({}, () => demoAnswer);
	expect(result.ok).toBe(true);
	expect(result.value.status).toBe("completed");
	const report = result.value.report;
	expect(report.coverage).toBe("partial");
	expect(report.scope).toMatchObject({
		baseline: demoScope.baseline, comparison: demoScope.comparison,
		requested_account_ids: ["acc_everyday", "acc_reserve"],
		included_account_ids: ["acc_everyday"],
		excluded_accounts: [{ account_id: "acc_reserve", reason: expect.stringContaining("excluded from both intervals") }],
	});
	expect(report.baseline).toEqual({ settled_count: 3, debit_count: 3, debits: 100 });
	expect(report.comparison).toEqual({ settled_count: 3, debit_count: 3, debits: 270 });
	expect(report.category_deltas).toEqual([
		{ name: "Dining", baseline_debits: 0, comparison_debits: 40, delta: 40, percent_change: null,
			baseline_count: 0, comparison_count: 1, baseline_ids: [], comparison_ids: ["trans_feb2"] },
		{ name: "Groceries", baseline_debits: 100, comparison_debits: 80, delta: -20, percent_change: -20,
			baseline_count: 3, comparison_count: 1, baseline_ids: ["trans_jan1", "trans_jan2", "trans_jan3"], comparison_ids: ["trans_feb1"] },
		{ name: "Transfers", baseline_debits: 0, comparison_debits: 150, delta: 150, percent_change: null,
			baseline_count: 0, comparison_count: 1, baseline_ids: [], comparison_ids: ["trans_feb3"] },
	]);
	expect(report.merchant_deltas).toEqual([
		expect.objectContaining({ name: "Fixture Cafe", delta: 40, comparison_ids: ["trans_feb2"] }),
		expect.objectContaining({ name: "Fixture Market", delta: -20, comparison_ids: ["trans_feb1"] }),
		expect.objectContaining({ name: "Fixture Savings", delta: 150, comparison_ids: ["trans_feb3"] }),
	]);
	expect(report.heuristic).toMatchObject({ baseline_median: 30, threshold: 100, status: "evaluated" });
	expect(report.unusual_debits).toEqual([expect.objectContaining({ id: "trans_feb3", debit: 150, type: "TRANSFER" })]);
	expect(report.elapsed_seconds.mismatch).toBe(true);
	expect(report.limitations).toEqual(expect.arrayContaining([expect.stringContaining("do not prove history completeness")]));
	expect(questions).toHaveLength(1);
	expect(questions[0]!.requestedSchema.properties.account_ids).toMatchObject({
		minItems: 1, items: { anyOf: [
			{ const: "acc_everyday", title: expect.any(String) },
			{ const: "acc_reserve", title: expect.any(String) },
		] },
	});
});

test("guided review preserves supplied scope and works without forms when fully specified", async () => {
	const direct = await syntheticReview(demoScope);
	expect(direct.result.ok).toBe(true);
	expect(direct.questions).toEqual([]);
	const existing = await syntheticReview(demoScope, undefined, { tool: "compareTransactionInsights" });
	expect(existing.result.ok).toBe(true);
	expect(direct.result.value.report).toEqual(existing.result.value);
	for (const input of [
		{ account_ids: ["acc_everyday"] },
		{ baseline: demoScope.baseline },
		{ baseline: demoScope.baseline, comparison: demoScope.comparison },
	]) {
		const run = await syntheticReview(input, form => {
			const fields = Object.keys(form.requestedSchema.properties);
			for (const supplied of Object.keys(input)) {
				expect(fields.some(field => field === supplied || field.startsWith(`${supplied}_`))).toBe(false);
			}
			return { action: "accept", content: Object.fromEntries(
				Object.entries(demoAnswer.content!).filter(([key]) => fields.includes(key)),
			) };
		});
		expect(run.result.ok).toBe(true);
		expect(run.result.value.report.scope.requested_account_ids).toEqual(input.account_ids ?? demoScope.account_ids);
		expect(run.result.value.report.scope.baseline).toEqual(demoScope.baseline);
		expect(run.result.value.report.scope.comparison).toEqual(demoScope.comparison);
		expect(run.result.value.report.baseline.debits).toBe(100);
		expect(run.result.value.report.comparison.debits).toBe(270);
	}
});

test("conflicting form answers cannot replace supplied accounts or either period", async () => {
	const scope = { ...demoScope, account_ids: ["acc_everyday"] };
	for (const missing of ["account_ids", "baseline", "comparison"] as const) {
		const input = Object.fromEntries(Object.entries(scope).filter(([key]) => key !== missing));
		// Answer the missing field correctly, but try to replace every supplied field.
		// Swapping the dates would reverse the comparison; Reserve would lose all coverage.
		const baseline = missing === "baseline" ? scope.baseline : scope.comparison;
		const comparison = missing === "comparison" ? scope.comparison : scope.baseline;
		const run = await syntheticReview(input, () => ({
			action: "accept",
			content: {
				account_ids: missing === "account_ids" ? ["acc_everyday"] : ["acc_reserve"],
				baseline_start: baseline.start, baseline_end: baseline.end,
				comparison_start: comparison.start, comparison_end: comparison.end,
			},
		}));
		expect(run.result.ok).toBe(true);
		expect(run.result.value.status).toBe("completed");
		expect(run.result.value.report.scope).toEqual({
			requested_account_ids: ["acc_everyday"], included_account_ids: ["acc_everyday"],
			excluded_accounts: [], baseline: scope.baseline, comparison: scope.comparison,
		});
		expect(run.result.value.report.coverage).toBe("queried");
		expect(run.result.value.report.baseline.debits).toBe(100);
		expect(run.result.value.report.comparison.debits).toBe(270);
		expect(run.transactionRequests).not.toContain("/v1/accounts/acc_reserve/transactions");
	}
});

test("declining, cancelling or lacking elicitation never reads transactions or returns a report", async () => {
	for (const action of ["cancel", "decline"] as const) {
		const run = await syntheticReview({}, () => ({ action }));
		expect(run.result).toMatchObject({ ok: true, value: { status: action === "cancel" ? "cancelled" : "declined" } });
		expect(run.result.value).not.toHaveProperty("report");
		expect(run.transactionRequests).toEqual([]);
	}
	const unavailable = await syntheticReview({});
	expect(unavailable.result.ok).toBe(false);
	expect(unavailable.transactionRequests).toEqual([]);
	const noAccounts = await syntheticReview({}, () => demoAnswer, { noEligibleAccounts: true });
	expect(noAccounts.result.ok).toBe(false);
	expect(noAccounts.questions).toEqual([]);
	expect(noAccounts.transactionRequests).toEqual([]);
});

test("guided review rejects invalid selections and intervals before reading transactions", async () => {
	for (const content of [
		{ ...demoAnswer.content, account_ids: [] },
		{ ...demoAnswer.content, account_ids: ["acc_foreign"] },
		{ ...demoAnswer.content, account_ids: ["acc_unoffered"] },
		{ ...demoAnswer.content, comparison_start: demoScope.baseline.end },
		{ ...demoAnswer.content, baseline_start: "2026-01-01T00:00:00" },
		{ ...demoAnswer.content, comparison_end: "2026-02-30T00:00:00+13:00" },
		{},
	]) {
		const run = await syntheticReview({}, () => ({ action: "accept", content }));
		expect(run.result.ok).toBe(false);
		expect(run.transactionRequests).toEqual([]);
	}
	for (const input of [
		{ ...demoScope, account_ids: [] },
		{ ...demoScope, comparison: demoScope.baseline },
	]) {
		const run = await syntheticReview(input);
		expect(run.result.ok).toBe(false);
		expect(run.transactionRequests).toEqual([]);
	}
	const excluded = await syntheticReview({ ...demoScope, account_ids: ["acc_foreign", "acc_unknown", "acc_nofeed"] });
	expect(excluded.result.ok).toBe(true);
	expect(excluded.result.value.report.coverage).toBe("unavailable");
	expect(excluded.result.value.report.scope.included_account_ids).toEqual([]);
	expect(excluded.result.value.report.scope.excluded_accounts).toHaveLength(3);
	expect(excluded.transactionRequests).toEqual([]);
});

test("the packaged review skill and example are discoverable through the host", async () => {
	const files = await Promise.all(["skills/reviewing-spending/SKILL.md", "skills/reviewing-spending/references/demo.md"].map(async path => ({
		path, content: await Bun.file(new URL(path, import.meta.url)).text(),
	})));
	const handle = createAppHandler(app);
	const response = await handle(new Request("https://app.test", {
		method: "POST", body: JSON.stringify({ operation: "skills" }),
	}), { ...hostContext({ app: {} }), files });
	const result = await response.json();
	expect(result.ok).toBe(true);
	expect(result.value).toEqual(expect.arrayContaining([expect.objectContaining({
		name: "reviewing-spending",
		files: expect.arrayContaining([
			expect.objectContaining({ path: "SKILL.md" }),
			expect.objectContaining({ path: "references/demo.md" }),
		]),
	})]));
});
