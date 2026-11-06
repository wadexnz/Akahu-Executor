import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createAppHandler, hostContext } from "apps/host";
import type { HostRequest } from "apps/contracts";
import app from "./index.js";
import { testDatabase } from "./test-database.js";

// The daily check through Executor's host boundary, with a real SQLite app database and a
// synthetic Akahu whose balances and history each test changes between checks.
const handle = createAppHandler(app);
const request = (body: HostRequest) => new Request("https://app.test", { method: "POST", body: JSON.stringify(body) });
const declaration = await (await handle(request({ operation: "requirements" }), hostContext({ app: {} }))).json();
const caller = (id: string) => ({ akahu: {
	id, provider: declaration.value.accounts.user.akahu.definition, method: "personalApp",
	fields: { "App ID Token": "synthetic-app", "User Access Token": "synthetic-user" },
} });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setSystemTime(); });

type Txn = { _id: string; _account: string; date: string; description: string; amount: number; type: string; merchant?: { name: string } };
type Acc = { _id: string; status?: string; available: number; currency?: string; synced?: string };
const bank = { accounts: [] as Acc[], rows: [] as Txn[], failTransactions: false };

function akahu() {
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new Request(input, init).url);
		if (url.origin !== "https://api.akahu.io") throw new Error("Unexpected origin");
		if (url.pathname === "/v1/accounts") return Response.json({ success: true, items: bank.accounts.map((a) => ({
			_id: a._id, name: a._id, status: a.status ?? "ACTIVE", type: "CHECKING", attributes: ["TRANSACTIONS"], connection: { name: "Synthetic Bank" },
			balance: { currency: a.currency ?? "NZD", current: a.available - 100, available: a.available },
			refreshed: { balance: a.synced ?? new Date().toISOString(), transactions: a.synced ?? new Date().toISOString() },
		})) });
		if (url.pathname === "/v1/transactions") {
			if (bank.failTransactions) return Response.json({ success: false, message: "down" }, { status: 503 });
			const start = Date.parse(url.searchParams.get("start")!), end = Date.parse(url.searchParams.get("end")!);
			return Response.json({ success: true, items: bank.rows.filter((t) => Date.parse(t.date) > start && Date.parse(t.date) <= end), cursor: { next: null } });
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
			return result;
		},
	};
}

const at = (iso: string) => setSystemTime(new Date(iso));
const kinds = (r: { value: { new_alerts: { kind: string }[] } }) => r.value.new_alerts.map((a) => a.kind).sort();

test("low-balance alerts fire when the balance crosses below the threshold, once, and are emitted as events", async () => {
	akahu();
	bank.rows = [];
	bank.accounts = [{ _id: "acc_everyday", available: 500 }, { _id: "acc_usd", available: 20, currency: "USD" }];
	const { as, database } = session();
	const alice = as("acc_alice"), bob = as("acc_bob");

	at("2026-11-01T19:00:00Z"); // 2 November 08:00 NZDT
	await expect(alice("monitor.setLowBalance", { account_id: "acc_missing", threshold: 10 })).rejects.toThrow("not a connected account");
	expect((await alice("monitor.setLowBalance", { account_id: "acc_everyday", threshold: 200 })).value).toEqual({ account_id: "acc_everyday", threshold: 200, currency: "NZD", removed: false });
	const first = await alice("monitor.check");
	expect(first.value).toMatchObject({ day: "2026-11-02", snapshots: 2, new_alerts: [], open_alert_count: 0, transaction_checks: "completed" });

	at("2026-11-02T19:00:00Z");
	bank.accounts[0]!.available = 150.5;
	const dropped = await alice("monitor.check");
	expect(dropped.value.new_alerts).toEqual([expect.objectContaining({
		kind: "low_balance", account_id: "acc_everyday", acknowledged: false,
		message: "acc_everyday (Synthetic Bank) has NZD 150.50 available, below your alert threshold of NZD 200.00.",
	})]);
	const alertId = dropped.value.new_alerts[0].id;
	// The event carries ids, not the message, and is attributed to the caller's account.
	expect(dropped.events).toEqual([{
		name: "alert.raised", id: alertId, occurredAt: Date.parse("2026-11-02T19:00:00Z"),
		data: { alert_id: alertId, kind: "low_balance", account_id: "acc_everyday" }, filters: { kind: "low_balance" }, account: "acc_alice",
	}]);

	// Running again the same day, or the next day while still low, raises nothing new.
	const rerun = await alice("monitor.check");
	expect(rerun.value.new_alerts).toEqual([]);
	expect(rerun.events ?? []).toEqual([]);
	at("2026-11-03T19:00:00Z");
	expect((await alice("monitor.check")).value.new_alerts).toEqual([]);
	// Back above, then below again: a new alert.
	at("2026-11-04T19:00:00Z");
	bank.accounts[0]!.available = 300;
	await alice("monitor.check");
	at("2026-11-05T19:00:00Z");
	bank.accounts[0]!.available = 199.99;
	expect(kinds(await alice("monitor.check"))).toEqual(["low_balance"]);

	expect((await alice("monitor.alerts")).value.map((a: { id: string }) => a.id)).toHaveLength(2);
	expect((await alice("monitor.acknowledge", { alert_ids: [alertId, alertId, "alert_other"] })).value).toEqual({ acknowledged: 1 });
	expect((await alice("monitor.alerts")).value).toHaveLength(1);
	expect((await alice("monitor.alerts", { include_acknowledged: true })).value).toHaveLength(2);

	// Bob shares the database but has no thresholds, alerts or history of his own.
	expect((await bob("monitor.alerts", { include_acknowledged: true })).value).toEqual([]);
	expect((await bob("monitor.lowBalanceAlerts")).value).toEqual([]);
	expect((await bob("monitor.acknowledge", { alert_ids: [alertId] })).value).toEqual({ acknowledged: 0 });
	expect((await bob("monitor.balanceHistory")).value.accounts).toEqual([]);
	expect(database.db.query("SELECT COUNT(*) AS n FROM balance_snapshots WHERE owner = 'acc_alice'").get()).toEqual({ n: 10 });

	expect((await alice("monitor.setLowBalance", { account_id: "acc_everyday" })).value).toEqual({ account_id: "acc_everyday", removed: true });
	expect((await alice("monitor.lowBalanceAlerts")).value).toEqual([]);
});

test("balance history keeps one snapshot per NZ day and totals each currency separately", async () => {
	akahu();
	bank.rows = [];
	bank.accounts = [{ _id: "acc_a", available: 1000 }, { _id: "acc_card", available: 300 }, { _id: "acc_usd", available: 50, currency: "USD" }];
	const alice = session().as("acc_alice");
	at("2026-11-04T10:30:00Z"); // 23:30 NZDT on 4 November
	await alice("monitor.check");
	bank.accounts[0]!.available = 1100;
	at("2026-11-04T11:30:00Z"); // 00:30 on 5 November: a new NZ day
	await alice("monitor.check");
	bank.accounts[0]!.available = 1200;
	bank.accounts = bank.accounts.filter((a) => a._id !== "acc_card"); // card disconnected
	at("2026-11-04T18:00:00Z"); // later on 5 November: replaces that day's snapshot
	await alice("monitor.check");

	const history = (await alice("monitor.balanceHistory", { days: 30 })).value;
	expect(history.to).toBe("2026-11-05");
	expect(history.accounts.find((a: { account_id: string }) => a.account_id === "acc_a").snapshots).toEqual([
		{ day: "2026-11-04", current: 900, available: 1000 }, { day: "2026-11-05", current: 1100, available: 1200 },
	]);
	// current = available - 100 in the synthetic bank; the card's 5 November snapshot is from before it disconnected.
	expect(history.totals).toEqual([
		{ currency: "NZD", days: [{ day: "2026-11-04", current: 1100, accounts_counted: 2 }, { day: "2026-11-05", current: 1300, accounts_counted: 2 }] },
		{ currency: "USD", days: [{ day: "2026-11-04", current: -50, accounts_counted: 1 }, { day: "2026-11-05", current: -50, accounts_counted: 1 }] },
	]);
	expect((await alice("monitor.balanceHistory", { account_id: "acc_usd" })).value.accounts.map((a: { account_id: string }) => a.account_id)).toEqual(["acc_usd"]);
	await expect(alice("monitor.balanceHistory", { days: 0 })).rejects.toThrow("days must be");
});

test("transaction and feed alerts are raised once; a failed history read still saves balances", async () => {
	akahu();
	const day = (n: number) => new Date(Date.parse("2026-11-01T00:00:00Z") - n * 864e5).toISOString();
	const tx = (id: string, n: number, amount: number, extra: Partial<Txn> = {}): Txn =>
		({ _id: id, _account: "acc_a", date: day(n), description: "Synthetic", amount, type: "DEBIT", ...extra });
	const streaming = (id: string, n: number) => tx(id, n, -19.99, { merchant: { name: "Streamly" } });
	bank.rows = [
		// Monthly since mid-August: new.
		streaming("trans_s1", 75), streaming("trans_s2", 45), streaming("trans_s3", 14),
		// Monthly for a year: not new.
		...Array.from({ length: 12 }, (_, i) => tx(`trans_p${i}`, 5 + i * 30, -60, { merchant: { name: "Power Co" } })),
		tx("trans_big", 2, -800, { description: "ROOF REPAIRS LTD" }), // first payment, within 7 days
		tx("trans_old_big", 20, -900, { description: "OLD THING" }), // first payment, but too old
		// Paired transfer between own accounts: never unusual.
		tx("trans_move", 1, -5000, { description: "TO SAVINGS" }), { ...tx("trans_move_in", 1, 5000), _account: "acc_savings" },
	];
	bank.accounts = [
		{ _id: "acc_a", available: 100 }, { _id: "acc_savings", available: 100 },
		{ _id: "acc_stale", available: 100, synced: "2026-10-29T00:00:00Z" },
		{ _id: "acc_dead", available: 100, status: "INACTIVE", synced: "2026-10-01T00:00:00Z" },
	];
	bank.failTransactions = false;
	const { as } = session();
	const alice = as("acc_alice");
	at("2026-11-01T00:00:00Z");
	const result = await alice("monitor.check");
	expect(kinds(result)).toEqual(["feed_inactive", "new_recurring", "stale_feed", "unusual_debit"]);
	const byKind = Object.fromEntries(result.value.new_alerts.map((a: { kind: string }) => [a.kind, a]));
	expect(byKind.unusual_debit).toMatchObject({ transaction_id: "trans_big", message: "NZD 800.00 to ROOF REPAIRS LTD on 2026-10-30: the first payment to this payee in the last 13 months of history." });
	expect(byKind.new_recurring).toMatchObject({ transaction_id: "trans_s3" });
	expect(byKind.new_recurring.message).toStartWith("New monthly payment to Streamly: about NZD 19.99 each time since 2026-08-18");
	expect(byKind.stale_feed).toMatchObject({ account_id: "acc_stale", message: "acc_stale (Synthetic Bank) transactions last synced 72 hours ago; Akahu normally syncs daily." });
	expect(result.value.open_alert_count).toBe(4);

	// An exclude rule the user adds later stops new unusual alerts for matching payees.
	await alice("memory.addRule", { kind: "exclude", match: { description: "roof" } });
	bank.rows.push(tx("trans_big2", 0, -700, { description: "ROOF REPAIRS LTD" }));
	at("2026-11-01T06:00:00Z");
	const again = await alice("monitor.check");
	expect(again.value.new_alerts).toEqual([]);
	expect(again.value.rules_applied).toEqual([expect.objectContaining({ count: 2 })]);

	bank.failTransactions = true;
	at("2026-11-02T06:00:00Z");
	const failed = await alice("monitor.check");
	expect(failed.value).toMatchObject({ transaction_checks: "failed", snapshots: 4 });
	// The stale account is older still, but it is the same sync, so it is not raised again.
	expect(failed.value.new_alerts).toEqual([]);
	bank.failTransactions = false;
});
