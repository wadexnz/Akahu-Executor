import { afterEach, expect, test } from "bun:test";
import { createAppHandler, hostContext } from "apps/host";
import type { HostRequest } from "apps/contracts";
import app from "./index.js";

// Calls tools through Executor's host boundary against a synthetic Akahu that
// answers only the routes a test declares and records every request.
type Route = (request: { method: string; body: unknown; query: URLSearchParams }) => Response;
const handle = createAppHandler(app);
const request = (body: HostRequest) => new Request("https://app.test", { method: "POST", body: JSON.stringify(body) });
const declaration = await (await handle(request({ operation: "requirements" }), hostContext({ app: {} }))).json();
const user = { akahu: {
	id: "acc_synthetic", provider: declaration.value.accounts.user.akahu.definition, method: "personalApp",
	fields: { "App ID Token": "synthetic-app", "User Access Token": "synthetic-user" },
} };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function akahu(routes: Record<string, Route>) {
	const requests: { method: string; path: string; body: unknown }[] = [];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const sent = new Request(input, init);
		const url = new URL(sent.url);
		const method = sent.method;
		const text = await sent.text();
		const body = text ? JSON.parse(text) : undefined;
		const path = url.pathname.replace(/^\/v1/, "");
		requests.push({ method, path, body });
		const route = routes[`${method} ${path}`];
		if (url.origin !== "https://api.akahu.io" || !route) throw new Error(`Unexpected ${method} ${path}`);
		return route({ method, body, query: url.searchParams });
	}, { preconnect: () => {} }) as typeof fetch;
	return requests;
}

async function call(tool: string, input: object = {}, approval?: unknown) {
	return (await handle(request({ operation: "call", tool, input: JSON.parse(JSON.stringify(input)) }), hostContext({ app: {}, user }, approval))).json();
}

const party = {
	_id: "party_1", _connection: "conn_bank", _user: "user_1", _authorisation: "auth_1", type: "INDIVIDUAL",
	name: { value: "Synthetic Person" }, dob: { value: "1990-01-02" }, tax_number: { value: "123-456-789" },
	email_addresses: [{ value: "person@example.test", subtype: "PRIMARY", verified: true }],
	phone_numbers: [],
	addresses: [{ value: "1 RAW ST", formatted: "1 Example Street, Wellington", subtype: "RESIDENTIAL", google_maps_place_id: "place" }],
};

test("identity data needs approval for the exact fields and returns only those fields", async () => {
	const requests = akahu({ "GET /parties": () => Response.json({ success: true, items: [party] }) });

	const unapproved = await call("identity.parties");
	expect(unapproved).toMatchObject({ ok: false, error: { _tag: "HostToolApprovalRequired" } });
	const nameOnly = { tool: "identity.parties", input: { fields: ["name"] } };
	// An approval for the name cannot be reused to read the IRD number.
	expect(await call("identity.parties", { fields: ["tax_number"] }, nameOnly)).toMatchObject({ ok: false });
	expect(requests).toEqual([]);

	const named = await call("identity.parties", {}, nameOnly);
	expect(named.value).toEqual({
		parties: [{ id: "party_1", connection_id: "conn_bank", name: "Synthetic Person" }],
		// phone_numbers is empty, so it is not reported as withheld.
		withheld_fields: ["dob", "tax_number", "email_addresses", "addresses"],
	});

	const irdInput = { fields: ["tax_number", "addresses"] };
	const ird = await call("identity.parties", irdInput, { tool: "identity.parties", input: irdInput });
	expect(ird.value.parties).toEqual([{
		id: "party_1", connection_id: "conn_bank", tax_number: "123-456-789",
		addresses: [{ value: "1 Example Street, Wellington", subtype: "RESIDENTIAL" }],
	}]);
	expect(ird.value.withheld_fields).toEqual(["name", "dob", "email_addresses"]);
	expect(JSON.stringify(ird.value)).not.toContain("1990-01-02");

	const bad = { fields: ["passport"] };
	expect(await call("identity.parties", bad, { tool: "identity.parties", input: bad })).toMatchObject({ ok: false });
	expect(requests).toHaveLength(2);
});

test("name verification sends only the supplied name parts and does not echo matched names", async () => {
	const flags = { given_name: true, middle_name: false, family_name: true, middle_initial: false, given_initial: true };
	const requests = akahu({ "POST /verify/name": ({ body }) => Response.json({ success: true, item: { name: body, sources: [
		{ type: "PARTY_NAME", match_result: "MATCH", verification: flags, meta: { value: "SYNTHETIC PERSON", sources: ["conn_bank"] } },
		{ type: "HOLDER_NAME", match_result: "PARTIAL_MATCH", verification: { ...flags, given_name: false },
			meta: { _id: "acc_1", name: "Everyday", formatted_account: "12-3456-7890123-00", holder: "MR S PERSON" } },
	] } }) });
	const input = { family_name: "Person", given_name: "Synthetic" };
	expect(await call("identity.verifyName", input)).toMatchObject({ ok: false, error: { _tag: "HostToolApprovalRequired" } });
	const result = await call("identity.verifyName", input, { tool: "identity.verifyName", input });
	expect(requests).toEqual([{ method: "POST", path: "/verify/name", body: input }]);
	expect(result.value.matches).toEqual([
		{ source: "PARTY_NAME", match_result: "MATCH", verification: flags, connection_ids: ["conn_bank"] },
		{ source: "HOLDER_NAME", match_result: "PARTIAL_MATCH", verification: { ...flags, given_name: false }, account_id: "acc_1", account_number: "12-3456-7890123-00" },
	]);
	expect(JSON.stringify(result.value)).not.toMatch(/SYNTHETIC PERSON|MR S PERSON/);
});

test("enrichment reports need approval, validate duplicates and are sent once", async () => {
	const requests = akahu({ "POST /support/trans_1": () => Response.json({ success: true }) });
	const duplicate = { transaction_id: "trans_1", type: "DUPLICATE" };
	expect(await call("admin.reportEnrichmentIssue", duplicate, { tool: "admin.reportEnrichmentIssue", input: duplicate })).toMatchObject({ ok: false });
	const wrongType = { transaction_id: "trans_1", type: "WRONG" };
	expect(await call("admin.reportEnrichmentIssue", wrongType, { tool: "admin.reportEnrichmentIssue", input: wrongType })).toMatchObject({ ok: false });
	const report = { transaction_id: "trans_1", type: "ENRICHMENT_ERROR", fields: ["merchant.name"], comment: "Not this shop" };
	expect(await call("admin.reportEnrichmentIssue", report)).toMatchObject({ ok: false, error: { _tag: "HostToolApprovalRequired" } });
	expect(requests).toEqual([]);
	const sent = await call("admin.reportEnrichmentIssue", report, { tool: "admin.reportEnrichmentIssue", input: report });
	expect(sent.value).toEqual({ reported: true, transaction_id: "trans_1", type: "ENRICHMENT_ERROR" });
	expect(requests).toEqual([{ method: "POST", path: "/support/trans_1", body: { type: "ENRICHMENT_ERROR", fields: ["merchant.name"], comment: "Not this shop" } }]);
});

const settled = (id: string, amount: number, group?: string, account = "acc_1") => ({
	_id: id, _account: account, _connection: "conn_bank", _user: "user_1", date: "2026-10-01T00:00:00Z", description: "Synthetic", amount, type: "DEBIT",
	...(group && { category: { _id: "nzfcc_x", name: `${group} thing`, groups: { personal_finance: { _id: "group_x", name: group } } } }),
});
const account = (id: string, extra: object = {}) => ({
	_id: id, name: id, status: "ACTIVE", type: "CHECKING", attributes: ["TRANSACTIONS"],
	connection: { _id: "conn_bank", name: "Synthetic Bank", logo: "https://example.test/logo.png", connection_type: "official" },
	balance: { currency: "NZD", current: -50, available: 450, limit: 500, overdrawn: false }, ...extra,
});

test("batch lookup dedupes ids and reports the ones Akahu did not return", async () => {
	const requests = akahu({ "POST /transactions/ids": ({ body }) => (body as string[]).includes("trans_bad")
		? Response.json({ success: false, message: "Invalid transaction id" }, { status: 400 })
		: Response.json({ success: true, items: (body as string[]).filter((id) => id !== "trans_gone").map((id) => settled(id, -1, "Food")) }) });
	const rejected = await call("transactions.getMany", { transaction_ids: ["trans_a", "trans_bad"] });
	expect(rejected).toMatchObject({ ok: false });
	expect(JSON.stringify(rejected)).toContain("Akahu rejected the request (400): Invalid transaction id. One malformed id makes Akahu reject the whole batch");
	requests.length = 0;
	const result = await call("transactions.getMany", { transaction_ids: ["trans_a", "trans_gone", "trans_a"] });
	expect(requests).toEqual([{ method: "POST", path: "/transactions/ids", body: ["trans_a", "trans_gone"] }]);
	expect(result.value.missing_ids).toEqual(["trans_gone"]);
	expect(result.value.transactions).toEqual([expect.objectContaining({ id: "trans_a", category: "Food thing", category_group: "Food" })]);
	expect(await call("transactions.getMany", { transaction_ids: Array.from({ length: 101 }, (_, i) => `trans_${i}`) })).toMatchObject({ ok: false });
	expect(await call("transactions.getMany", { transaction_ids: [] })).toMatchObject({ ok: false });
	expect(requests).toHaveLength(1);
});

test("pending can be scoped to one account and accounts.get reads one account live", async () => {
	const requests = akahu({
		"GET /accounts/acc_1/transactions/pending": () => Response.json({ success: true, items: [{ _account: "acc_1", date: "2026-10-01T00:00:00Z", description: "Pending", amount: -5, type: "EFTPOS" }] }),
		"GET /accounts/acc_1": () => Response.json({ success: true, item: account("acc_1") }),
	});
	expect((await call("transactions.pending", { account_id: "acc_1" })).value).toEqual([{ pending: true, account_id: "acc_1", date: "2026-10-01T00:00:00Z", description: "Pending", amount: -5, type: "EFTPOS" }]);
	expect((await call("accounts.get", { account_id: "acc_1" })).value).toMatchObject({
		id: "acc_1", connection_type: "official", balance: { currency: "NZD", current: -50, available: 450, limit: 500, overdrawn: false },
	});
	expect(requests.map((r) => r.path)).toEqual(["/accounts/acc_1/transactions/pending", "/accounts/acc_1"]);
});

test("personal-finance groups filter and group transactions; unknown groups fail before any request", async () => {
	const rows = [settled("trans_food1", -10, "Food"), settled("trans_food2", -15.5, "Food"), settled("trans_bus", -4, "Transport"), settled("trans_none", -99)];
	const requests = akahu({
		"GET /accounts": () => Response.json({ success: true, items: [account("acc_1")] }),
		"GET /transactions": () => Response.json({ success: true, items: rows, cursor: { next: null } }),
	});
	const food = await call("transactions.search", { group: "food" });
	expect(food.value.transactions.map((t: { id: string }) => t.id)).toEqual(["trans_food1", "trans_food2"]);
	expect(food.value.currencies).toEqual([{ currency: "NZD", net_total: -25.5 }]);

	const byGroup = await call("transactions.summary", { group_by: "group" });
	expect(byGroup.value.currencies[0].groups).toEqual([
		{ name: "Ungrouped", count: 1, total: -99 }, { name: "Food", count: 2, total: -25.5 }, { name: "Transport", count: 1, total: -4 },
	]);
	const transportOnly = await call("transactions.summary", { group: "Transport", group_by: "merchant" });
	expect(transportOnly.value.transaction_count).toBe(1);

	const before = requests.length;
	const typo = await call("transactions.search", { group: "Foods" });
	expect(typo).toMatchObject({ ok: false });
	expect(requests).toHaveLength(before);
});

test("freshness reports sync ages and plain warnings", async () => {
	const hoursAgo = (h: number) => new Date(Date.now() - h * 36e5).toISOString();
	akahu({ "GET /accounts": () => Response.json({ success: true, items: [
		account("acc_fresh", { refreshed: { balance: hoursAgo(2), transactions: hoursAgo(3) } }),
		account("acc_stale", { refreshed: { balance: hoursAgo(50), transactions: hoursAgo(72) } }),
		account("acc_inactive", { status: "INACTIVE", refreshed: { balance: hoursAgo(1), transactions: hoursAgo(1) } }),
		account("acc_new", { refreshed: { balance: hoursAgo(1) } }),
	] }) });
	const result = (await call("accounts.freshness")).value.accounts;
	expect(result.map((a: { warnings: string[] }) => a.warnings)).toEqual([
		[],
		["Balance last synced 50 hours ago; Akahu normally syncs daily.", "Transactions last synced 72 hours ago; Akahu normally syncs daily."],
		[expect.stringMatching(/^INACTIVE:/)],
		["Transactions have not been synced yet."],
	]);
	expect(result[0].refreshed.transactions.age_hours).toBeCloseTo(3, 0);
	expect(result[0].connection_type).toBe("official");
});

test("the bundled NZFCC list filters by group, direction and name without calling Akahu", async () => {
	const requests = akahu({});
	const all = (await call("categories.list")).value;
	expect(all.categories).toHaveLength(213);
	expect(all.groups).toEqual(["Appearance", "Education", "Food", "Health", "Household", "Housing", "Lifestyle", "Professional Services", "Transport", "Utilities"]);
	const credit = (await call("categories.list", { direction: "credit" })).value.categories;
	expect(credit.length).toBeGreaterThan(0);
	expect(credit.every((c: { group?: string; direction: string }) => c.direction === "credit" && c.group === undefined)).toBe(true);
	const food = (await call("categories.list", { group: "FOOD", search: "supermarket" })).value.categories;
	expect(food.length).toBeGreaterThan(0);
	expect(food.every((c: { group: string; name: string }) => c.group === "Food" && /supermarket/i.test(c.name))).toBe(true);
	expect(await call("categories.list", { direction: "sideways" })).toMatchObject({ ok: false });
	expect(requests).toEqual([]);
});
