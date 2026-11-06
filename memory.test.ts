import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createAppHandler, hostContext } from "apps/host";
import type { HostRequest } from "apps/contracts";
import app from "./index.js";
import { testDatabase } from "./test-database.js";

// Memory and insights through Executor's host boundary, with a real SQLite app database and a
// synthetic Akahu. Two callers share the database, as members of one organisation do.
const handle = createAppHandler(app);
const request = (body: HostRequest) => new Request("https://app.test", { method: "POST", body: JSON.stringify(body) });
const declaration = await (await handle(request({ operation: "requirements" }), hostContext({ app: {} }))).json();
const caller = (id: string) => ({ akahu: {
	id, provider: declaration.value.accounts.user.akahu.definition, method: "personalApp",
	fields: { "App ID Token": "synthetic-app", "User Access Token": "synthetic-user" },
} });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setSystemTime(); });

type Txn = { _id: string; _account: string; date: string; description: string; amount: number; type: string; category?: object; merchant?: { name: string } };
const accounts = ["acc_everyday", "acc_savings", "acc_usd"].map((id) => ({
	_id: id, name: id, status: "ACTIVE", type: "CHECKING", attributes: ["TRANSACTIONS"], connection: { name: "Synthetic Bank" },
	balance: { currency: id === "acc_usd" ? "USD" : "NZD", current: 0 },
}));

function akahu(rows: Txn[]) {
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new Request(input, init).url);
		if (url.origin !== "https://api.akahu.io") throw new Error("Unexpected origin");
		if (url.pathname === "/v1/accounts") return Response.json({ success: true, items: accounts });
		if (url.pathname === "/v1/transactions") {
			// Akahu's start is exclusive and end inclusive.
			const start = Date.parse(url.searchParams.get("start") ?? "1970-01-01T00:00:00Z"), end = Date.parse(url.searchParams.get("end") ?? "2100-01-01T00:00:00Z");
			return Response.json({ success: true, items: rows.filter((t) => Date.parse(t.date) > start && Date.parse(t.date) <= end), cursor: { next: null } });
		}
		throw new Error(`Unexpected ${url.pathname}`);
	}, { preconnect: () => {} }) as typeof fetch;
}

function session(database = testDatabase()) {
	return {
		database,
		as: (id: string) => async (tool: string, input: object = {}) => {
			const result = await (await handle(request({ operation: "call", tool, input: JSON.parse(JSON.stringify(input)) }), { ...hostContext({ app: {}, user: caller(id) }), ...database.context })).json();
			if (!result.ok) throw new Error(`${tool}: ${JSON.stringify(result.error)}`);
			return result.value;
		},
	};
}

const tx = (id: string, account: string, date: string, amount: number, extra: Partial<Txn> = {}): Txn =>
	({ _id: id, _account: account, date, description: "Synthetic", amount, type: amount < 0 ? "DEBIT" : "CREDIT", ...extra });

test("notes and tags appear on transactions, filter search, and stay with the caller who saved them", async () => {
	akahu([tx("trans_1", "acc_everyday", "2026-10-01T00:00:00Z", -10), tx("trans_2", "acc_everyday", "2026-10-02T00:00:00Z", -20)]);
	const { as, database } = session();
	const alice = as("acc_alice"), bob = as("acc_bob");

	expect(await alice("memory.setNote", { transaction_id: "trans_1", note: "  Dinner with Sam  " })).toEqual({ transaction_id: "trans_1", note: "Dinner with Sam", deleted: false });
	expect(await alice("memory.tag", { transaction_ids: ["trans_1", "trans_2", "trans_1"], tag: " Work Expense " })).toEqual({ tag: "work expense", added: 2 });
	expect(await alice("memory.tag", { transaction_ids: ["trans_1"], tag: "WORK EXPENSE" })).toEqual({ tag: "work expense", added: 0 });

	const search = await alice("transactions.search", { tag: "work expense" });
	expect(search.transactions.map((t: { id: string; note?: string; tags?: string[] }) => [t.id, t.note, t.tags])).toEqual([
		["trans_1", "Dinner with Sam", ["work expense"]], ["trans_2", undefined, ["work expense"]],
	]);
	expect(await alice("memory.listTags")).toEqual({ tags: [{ tag: "work expense", count: 2 }], note_count: 1 });

	// Another member of the organisation sees none of it, through any tool.
	expect(await bob("memory.listTags")).toEqual({ tags: [], note_count: 0 });
	expect((await bob("transactions.search", {})).transactions.every((t: { note?: string; tags?: string[] }) => !t.note && !t.tags)).toBe(true);
	expect((await bob("transactions.search", { tag: "work expense" })).transactions).toEqual([]);
	expect(await bob("memory.untag", { transaction_ids: ["trans_1"], tag: "work expense" })).toEqual({ tag: "work expense", removed: 0 });
	expect(await bob("memory.setNote", { transaction_id: "trans_1", note: "" })).toEqual({ transaction_id: "trans_1", deleted: true });
	expect(database.db.query("SELECT COUNT(*) AS n FROM notes").get()).toEqual({ n: 1 });

	expect(await alice("memory.untag", { transaction_ids: ["trans_2"], tag: "work expense" })).toEqual({ tag: "work expense", removed: 1 });
	await alice("memory.setNote", { transaction_id: "trans_1", note: "" });
	expect(await alice("memory.listTags")).toEqual({ tags: [{ tag: "work expense", count: 1 }], note_count: 0 });
	await expect(alice("memory.tag", { transaction_ids: ["trans_1"], tag: "   " })).rejects.toThrow();
});

test("rules are validated, kept per caller, and change what cash flow counts", async () => {
	setSystemTime(new Date("2026-11-10T00:00:00Z"));
	akahu([
		tx("trans_pay", "acc_everyday", "2026-10-15T00:00:00Z", 4000, { description: "SALARY" }),
		tx("trans_rent", "acc_everyday", "2026-10-16T00:00:00Z", -2000, { description: "RENT" }),
		// Paired automatically: same amount, two of the user's accounts, the same NZ day.
		tx("trans_save_out", "acc_everyday", "2026-10-20T00:00:00Z", -500, { description: "TO SAVINGS" }),
		tx("trans_save_in", "acc_savings", "2026-10-20T03:00:00Z", 500, { description: "FROM EVERYDAY" }),
		// A repayment to a card Akahu does not see: only a rule can call it a transfer.
		tx("trans_card", "acc_everyday", "2026-10-25T00:00:00Z", -800, { description: "CREDIT CARD PAYMENT" }),
		// NZ time: 30 September 23:30 UTC is 1 October in NZ, so it belongs to October.
		tx("trans_early", "acc_everyday", "2026-09-30T11:30:00Z", -30, { description: "LATE NIGHT" }),
		tx("trans_sept", "acc_everyday", "2026-09-30T10:00:00Z", -70, { description: "SEPT" }),
		tx("trans_nov", "acc_everyday", "2026-11-02T00:00:00Z", -40, { description: "NOV" }),
		tx("trans_usd", "acc_usd", "2026-10-05T00:00:00Z", -9, { description: "USD THING" }),
	]);
	const { as } = session();
	const alice = as("acc_alice"), bob = as("acc_bob");

	await expect(alice("memory.addRule", { kind: "transfer", match: {} })).rejects.toThrow("at least one of");
	await expect(alice("memory.addRule", { kind: "ignore", match: { description: "x" } })).rejects.toThrow("kind must be one of");
	await expect(alice("memory.addRule", { kind: "transfer", match: { description: "x", direction: "sideways" } })).rejects.toThrow("direction");
	const rule = await alice("memory.addRule", { kind: "transfer", match: { description: " credit card ", direction: "debit" }, reason: "Card repayments" });
	expect(rule).toMatchObject({ kind: "transfer", match: { description: "credit card", direction: "debit" }, reason: "Card repayments" });
	expect(await alice("memory.listRules")).toEqual([rule]);
	expect(await bob("memory.listRules")).toEqual([]);
	expect(await bob("memory.removeRule", { rule_id: rule.id })).toEqual({ removed: false });

	const flow = await alice("insights.cashflow", { months: 3 });
	expect(flow.period.start).toBe("2026-08-31T12:00:00.000Z"); // 1 September, NZST
	const nzd = flow.currencies.find((c: { currency: string }) => c.currency === "NZD");
	expect(nzd.months).toEqual([
		{ month: "2026-09", partial: false, income: 0, spending: -70, net: -70, saving: 0, transfers_left_out: 0, excluded_by_rules: 0, top_spending: [{ category: "Uncategorised", amount: 70 }] },
		{ month: "2026-10", partial: false, income: 4000, spending: -2030, net: 1970, saving: 0, transfers_left_out: 3, excluded_by_rules: 0, top_spending: [{ category: "Uncategorised", amount: 2030 }] },
		{ month: "2026-11", partial: true, income: 0, spending: -40, net: -40, saving: 0, transfers_left_out: 0, excluded_by_rules: 0, top_spending: [{ category: "Uncategorised", amount: 40 }] },
	]);
	expect(nzd.total).toEqual({ income: 4000, spending: -2140, net: 1860, saving: 0 });
	expect(flow.currencies.map((c: { currency: string }) => c.currency)).toEqual(["NZD", "USD"]);
	expect(flow.rules_applied).toEqual([{ rule_id: rule.id, count: 1 }]);

	// Without the rule (Bob's view of the same bank data), the card repayment is money out.
	const bobOct = (await bob("insights.cashflow", { months: 3 })).currencies[0].months[1];
	expect(bobOct).toMatchObject({ spending: -2830, transfers_left_out: 2 });

	// Search shows each row's flow; filtering to one account keeps a transfer's other side.
	const moved = await alice("transactions.search", { account_id: "acc_everyday", flow: "transfer" });
	expect(moved.transactions.map((t: { id: string; flow: string }) => [t.id, t.flow])).toEqual([["trans_save_out", "transfer"], ["trans_card", "transfer"]]);
	expect((await bob("transactions.search", { account_id: "acc_everyday", flow: "transfer" })).transactions.map((t: { id: string }) => t.id)).toEqual(["trans_save_out"]);
	await expect(alice("transactions.search", { flow: "transfers" })).rejects.toThrow("flow must be one of");

	expect(await alice("memory.removeRule", { rule_id: rule.id })).toEqual({ removed: true });
	expect(await alice("memory.listRules")).toEqual([]);
});

test("budget status compares one NZ month's group spending with the caller's budgets", async () => {
	setSystemTime(new Date("2026-10-16T11:00:00Z")); // 17 October 00:00 NZDT: 16 of 31 days gone
	const food = { category: { name: "Supermarkets", groups: { personal_finance: { name: "Food" } } } };
	const fun = { category: { name: "Cinemas", groups: { personal_finance: { name: "Lifestyle" } } } };
	akahu([
		tx("trans_a", "acc_everyday", "2026-10-03T00:00:00Z", -120.5, food),
		tx("trans_b", "acc_everyday", "2026-10-09T00:00:00Z", -80, food),
		tx("trans_c", "acc_everyday", "2026-10-10T00:00:00Z", -35, fun),
		tx("trans_refund", "acc_everyday", "2026-10-11T00:00:00Z", 20, food),
		tx("trans_last_month", "acc_everyday", "2026-09-29T00:00:00Z", -999, food),
		tx("trans_usd", "acc_usd", "2026-10-05T00:00:00Z", -15, food),
	]);
	const { as } = session();
	const alice = as("acc_alice"), bob = as("acc_bob");
	await expect(alice("memory.setBudget", { group: "Foods", monthly_amount: 400 })).rejects.toThrow("Unknown category group");
	expect(await alice("memory.setBudget", { group: "food", monthly_amount: 400 })).toEqual({ budget: { group: "Food", currency: "NZD", monthly_amount: 400 }, removed: false });
	await alice("memory.setBudget", { group: "Food", monthly_amount: 500 });
	await alice("memory.setBudget", { group: "Food", monthly_amount: 50, currency: "usd" });
	expect(await alice("memory.listBudgets")).toEqual([
		{ group: "Food", currency: "NZD", monthly_amount: 500 }, { group: "Food", currency: "USD", monthly_amount: 50 },
	]);
	expect(await bob("memory.listBudgets")).toEqual([]);

	const status = await alice("insights.budgetStatus");
	expect(status).toMatchObject({ month: "2026-10", month_elapsed_percent: 51.61 });
	expect(status.budgets).toEqual([
		{ group: "Food", currency: "NZD", budget: 500, spent: 200.5, remaining: 299.5, percent_used: 40.1 },
		{ group: "Food", currency: "USD", budget: 50, spent: 15, remaining: 35, percent_used: 30 },
	]);
	expect(status.unbudgeted).toEqual([{ group: "Lifestyle", currency: "NZD", spent: 35 }]);
	expect((await alice("insights.budgetStatus", { month: "2026-09" })).budgets[0]).toMatchObject({ spent: 999, percent_used: 199.8 });
	await expect(alice("insights.budgetStatus", { month: "2026-12" })).rejects.toThrow("has not started");
	expect(await alice("memory.setBudget", { group: "Food", monthly_amount: 0, currency: "USD" })).toEqual({ removed: true });
});

test("recurring, merchant history and unusual debits read the caller's history through the host", async () => {
	setSystemTime(new Date("2026-10-20T00:00:00Z"));
	const spotify = (date: string, id: string) => tx(id, "acc_everyday", date, -14.99, { description: `SPOTIFY ${id}`, merchant: { name: "Spotify" } });
	akahu([
		spotify("2026-07-03T00:00:00Z", "trans_s1"), spotify("2026-08-03T00:00:00Z", "trans_s2"),
		spotify("2026-09-03T00:00:00Z", "trans_s3"), spotify("2026-10-03T00:00:00Z", "trans_s4"),
		tx("trans_spotify_refund", "acc_everyday", "2026-10-04T00:00:00Z", 14.99, { description: "SPOTIFY REFUND" }),
		tx("trans_dentist", "acc_everyday", "2026-10-12T00:00:00Z", -450, { description: "CITY DENTAL" }),
	]);
	const alice = session().as("acc_alice");
	const recurring = await alice("insights.recurring", {});
	expect(recurring.payments).toEqual([expect.objectContaining({ payee: "Spotify", cadence: "monthly", occurrences: 4, status: "active", evidence_ids: ["trans_s1", "trans_s2", "trans_s3", "trans_s4"] })]);
	expect(recurring.totals).toEqual([{ currency: "NZD", active_count: 1, active_monthly_equivalent: -14.99 }]);

	const history = await alice("insights.merchantHistory", { merchant: "spotify" });
	expect(history.matched_payees).toEqual([{ payee: "Spotify", count: 4 }, { payee: "SPOTIFY REFUND", count: 1 }]);
	expect(history.currencies).toEqual([expect.objectContaining({ currency: "NZD", count: 5, total: -44.97, first_date: "2026-07-03", last_date: "2026-10-04" })]);
	expect(history.currencies[0].months.at(-1)).toEqual({ month: "2026-10", count: 2, total: 0 });
	expect(history.recent_ids[0]).toBe("trans_spotify_refund");

	const unusual = await alice("insights.largeOrUnusual", {});
	expect(unusual.debits.map((d: { id: string; reason: string }) => [d.id, d.reason])).toEqual([["trans_dentist", "first_payment_to_payee"]]);
	await expect(alice("insights.recurring", { months: 1 })).rejects.toThrow("months must be a whole number");
});
