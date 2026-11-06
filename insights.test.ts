import { expect, test } from "bun:test";
import { Account, Transaction, PendingTransaction, User, fetchTransactions, getItem, getItems } from "./akahu.js";
import { compareInsights } from "./insights.js";

// Synthetic Akahu HTTP API; anything unexpected fails the request.
const row = (id: string, amount: number, date: string, enriched = true, account = "acc_good"): Transaction => {
	const transaction = {
		_id: id, _account: account, date, amount, type: id === "trans_large" ? "TRANSFER" : "DEBIT",
		description: "Synthetic transaction",
	};
	if (enriched) return { ...transaction, category: { name: "Groceries" }, merchant: { name: "Fixture shop" } };
	return transaction;
};
const accounts: Account[] = [
	{ _id: "acc_good", balance: { currency: "NZD", current: 0 }, attributes: ["TRANSACTIONS"], status: "ACTIVE" },
	{ _id: "acc_empty", balance: { currency: "NZD", current: 0 }, attributes: ["TRANSACTIONS"], status: "INACTIVE" },
	{ _id: "acc_failed", balance: { currency: "NZD", current: 0 }, attributes: ["TRANSACTIONS"] },
	{ _id: "acc_foreign", balance: { currency: "USD", current: 0 }, attributes: ["TRANSACTIONS"] },
	{ _id: "acc_unknown", attributes: ["TRANSACTIONS"] },
	{ _id: "acc_nofeed", balance: { currency: "NZD", current: 0 }, attributes: [] },
	{ _id: "acc_high", balance: { currency: "NZD", current: 0 }, attributes: ["TRANSACTIONS"] },
].map(a => ({ ...a, name: a._id, type: "CHECKING", status: a.status ?? "ACTIVE", connection: { name: "Synthetic Bank" } }));

function page(account: string, q: URLSearchParams) {
	const start = q.get("start"), end = q.get("end"), cursor = q.get("cursor");
	const baseline = start === "2026-01-01T00:00:00Z";
	if (start !== (baseline ? "2026-01-01T00:00:00Z" : "2026-02-01T00:00:00Z") ||
		end !== (baseline ? "2026-01-02T00:00:00Z" : "2026-02-03T00:00:00Z")) throw new Error("Lost date bounds on pagination");
	if (account === "acc_failed") {
		if (baseline) return Response.json({ success: true, items: [row("trans_failed", -9999, start!, true, account)], cursor: { next: null } });
		return Response.json({ success: false, message: "Synthetic feed failure" }, { status: 500 });
	}
	if (account === "acc_empty") return Response.json({ success: true, items: [], cursor: {} });
	if (account === "acc_high") return Response.json({
		success: true,
		items: (baseline ? [100, 200, 300, 400] : [749, 750]).map((a) => row(`trans_${a}`, -a, start!, true, account)),
		cursor: { next: null },
	});
	if (account !== "acc_good") throw new Error("Excluded account must not be queried");
	if (!cursor) return Response.json({
		success: true,
		items: baseline ? [row("trans_a", -10, start!), row("trans_b", -20, start!)] : [row("trans_large", -100, start!), row("trans_credit", 900, start!)],
		cursor: { next: "page2" },
	});
	if (cursor !== "page2") throw new Error("Unexpected cursor");
	return Response.json({
		success: true,
		items: baseline
			? [row("trans_b", -20, start!), row("trans_c", -30, end!), row("trans_out", -5000, "2025-12-31T23:59:59Z"), row("trans_wrong", -5000, start!, true, "acc_other")]
			: [row("trans_large", -100, start!), row("trans_new", -40, end!, false), row("trans_small", -99, start!)],
		cursor: {},
	});
}

const client = {
	headers: {},
	signal: new AbortController().signal,
	fetch: async (input: string) => {
		const u = new URL(input);
		if (u.pathname === "/v1/accounts") return Response.json({ success: true, items: accounts });
		const m = /^\/v1\/accounts\/([^/]+)\/transactions$/.exec(u.pathname);
		if (!m) throw new Error(`Unexpected request ${u.pathname}`);
		return page(m[1]!, u.searchParams);
	},
};

test("insights validate explicit scope and explain paginated debit comparisons", async () => {
	const baseline = { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" };
	const comparison = { start: "2026-02-01T00:00:00Z", end: "2026-02-03T00:00:00Z" };
	const call = (account_ids: string[], b = baseline, c = comparison) => compareInsights(client, { account_ids, baseline: b, comparison: c });
	for (const [ids, b, c] of [
		[[], baseline, comparison],
		[["acc_good"], { ...baseline, start: "2026-02-30T00:00:00Z" }, comparison],
		[["acc_good"], { ...baseline, start: "2026-01-01" }, comparison],
		[["acc_good"], { ...baseline, start: "2026-01-01T00:00:00" }, comparison],
		[["acc_good"], { start: baseline.end, end: baseline.start }, comparison],
		[["acc_good"], baseline, baseline],
		[["acc_good"], baseline, { ...comparison, start: baseline.end }],
	] as const) await expect(call([...ids], b, c)).rejects.toThrow();

	const report = await call(["acc_good", "acc_good", "acc_empty", "acc_missing", "acc_foreign", "acc_unknown", "acc_nofeed", "acc_failed"]);
	expect(report.coverage).toBe("partial");
	expect(report.scope.included_account_ids).toEqual(["acc_good", "acc_empty"]);
	expect(report.scope.excluded_accounts.map((a) => a.account_id)).toEqual(["acc_missing", "acc_foreign", "acc_unknown", "acc_nofeed", "acc_failed"]);
	expect(report.elapsed_seconds).toEqual({ baseline: 86400, comparison: 172800, mismatch: true });
	expect(report.baseline).toEqual({ settled_count: 3, debit_count: 3, debits: 60 });
	expect(report.comparison).toEqual({ settled_count: 4, debit_count: 3, debits: 239 });
	expect(report.category_deltas).toEqual([
		{ name: "Groceries", baseline_debits: 60, comparison_debits: 199, delta: 139, percent_change: 231.67,
			baseline_count: 3, comparison_count: 2, baseline_ids: ["trans_a", "trans_b", "trans_c"], comparison_ids: ["trans_large", "trans_small"] },
		{ name: "Uncategorised", baseline_debits: 0, comparison_debits: 40, delta: 40, percent_change: null,
			baseline_count: 0, comparison_count: 1, baseline_ids: [], comparison_ids: ["trans_new"] },
	]);
	expect(report.merchant_deltas[0]).toEqual({ ...report.category_deltas[0]!, name: "Fixture shop" });
	expect(report.merchant_deltas[1]!.name).toBe("Unknown merchant");
	expect(report.heuristic).toMatchObject({ baseline_median: 20, threshold: 100, status: "evaluated", baseline_evidence_ids: ["trans_a", "trans_b", "trans_c"] });
	expect(report.unusual_debits.map((t) => [t.id, t.type])).toEqual([["trans_large", "TRANSFER"]]);

	const high = await call(["acc_high"]);
	expect(high.coverage).toBe("queried");
	expect(high.heuristic).toMatchObject({ baseline_median: 250, threshold: 750 });
	expect(high.unusual_debits.map((t) => t.id)).toEqual(["trans_750"]);

	const empty = await call(["acc_empty"]);
	expect(empty.heuristic).toMatchObject({ status: "insufficient_baseline", threshold: null });
	expect(empty.unusual_debits).toEqual([]);
	expect(empty.account_metadata[0]!.status).toBe("INACTIVE");

	const unavailable = await call(["acc_missing"]);
	expect(unavailable.coverage).toBe("unavailable");
	expect(unavailable.scope.included_account_ids).toEqual([]);
});

test("Akahu response decoders preserve optional enrichment and reject malformed amounts", async () => {
	const transaction = { ...row("trans_decoded", -10, "2026-01-01T00:00:00Z", false), balance: 0,
		meta: { reference: "fixture", conversion: { amount: -6, currency: "USD", rate: 0.6 } } };
	const decoded = await getItem({ ...client, fetch: async () => Response.json({ item: { ...transaction, extra: "ignored" } }) }, "/transactions/trans_decoded", Transaction);
	expect(decoded).toEqual(transaction);
	expect(decoded).not.toHaveProperty("merchant");
	const pending = { _account: transaction._account, date: transaction.date, amount: -10, description: "Pending", type: "DEBIT" };
	expect(await getItems({ ...client, fetch: async () => Response.json({ items: [pending] }) }, "/transactions/pending", PendingTransaction)).toEqual([pending]);
	expect(await getItem({ ...client, fetch: async () => Response.json({ item: { _id: "user_fixture" } }) }, "/me", User)).toEqual({ _id: "user_fixture" });
	for (const malformed of [{ ...transaction, amount: "-10" }, { ...transaction, balance: "0" }]) {
		const invalid = { ...client, fetch: async () => Response.json({ item: malformed, items: [malformed] }) };
		await expect(getItem(invalid, "/transactions/trans_decoded", Transaction)).rejects.toThrow();
		await expect(fetchTransactions(invalid, {})).rejects.toThrow();
	}
	await expect(getItems({ ...client, fetch: async () => Response.json({ items: [{ ...accounts[0], attributes: "TRANSACTIONS" }] }) }, "/accounts", Account)).rejects.toThrow();
});

test("history decoding handles terminal cursors and refuses malformed or repeated cursors", async () => {
	for (const envelope of [{}, { cursor: {} }, { cursor: { next: null } }]) {
		const terminal = { ...client, fetch: async () => Response.json({ items: [], ...envelope }) };
		expect(await fetchTransactions(terminal, {})).toEqual([]);
	}
	const malformed = { ...client, fetch: async () => Response.json({ items: [], cursor: { next: 123 } }) };
	await expect(fetchTransactions(malformed, {})).rejects.toThrow();
	let pages = 0;
	const repeated = { ...client, fetch: async () => {
		pages++;
		return Response.json({ items: [], cursor: { next: "same-page" } });
	} };
	await expect(fetchTransactions(repeated, {})).rejects.toThrow("Akahu repeated a history cursor");
	expect(pages).toBe(2);
});
