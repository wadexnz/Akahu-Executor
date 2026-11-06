import { expect, test } from "bun:test";
import type { AppCache } from "apps";
import { fetchAccounts, fetchTransactions, getItems, invalidateCache, post, retryDelay, type Akahu } from "./client.js";
import { User } from "./schemas.js";

// Synthetic Akahu: answers with the queued responses in order and records each request.
function akahu(...responses: Response[]) {
	const requests: string[] = [];
	const c: Akahu = {
		headers: {}, signal: new AbortController().signal,
		fetch: async (input, init) => {
			requests.push(`${init?.method ?? "GET"} ${new URL(input).pathname}${new URL(input).search}`);
			const next = responses.shift();
			if (!next) throw new Error("Unexpected extra request");
			return next;
		},
	};
	return { c, requests };
}
const status = (code: number, headers: Record<string, string> = {}) => Response.json({ success: false, message: "synthetic" }, { status: code, headers });
const account = { _id: "acc_1", name: "Everyday", status: "ACTIVE", type: "CHECKING", attributes: ["TRANSACTIONS"], connection: { name: "Synthetic Bank" } };
const row = (id: string) => ({ _id: id, _account: "acc_1", date: "2026-10-01T00:00:00Z", description: "Synthetic", amount: -1, type: "DEBIT" });

test("rate-limited reads back off and retry; writes and other failures are not retried", async () => {
	const recovered = akahu(status(429, { "retry-after": "0" }), status(429, { "retry-after": "0" }), Response.json({ items: [{ _id: "user_1" }] }));
	expect(await getItems(recovered.c, "/me", User)).toEqual([{ _id: "user_1" }]);
	expect(recovered.requests).toHaveLength(3);

	const exhausted = akahu(...Array.from({ length: 4 }, () => status(429, { "retry-after": "0" })));
	await expect(getItems(exhausted.c, "/me", User)).rejects.toMatchObject({ _tag: "ProviderError", reason: "rate_limited", status: 429 });
	expect(exhausted.requests).toHaveLength(4);

	const refresh = akahu(status(429, { "retry-after": "0" }));
	await expect(post(refresh.c, "/refresh")).rejects.toMatchObject({ reason: "rate_limited" });
	expect(refresh.requests).toEqual(["POST /v1/refresh"]);

	for (const [code, reason] of [[401, "unauthorized"], [403, "rejected"], [503, "unavailable"]] as const) {
		const failed = akahu(status(code));
		await expect(getItems(failed.c, "/me", User)).rejects.toMatchObject({ _tag: "ProviderError", reason, status: code });
		expect(failed.requests).toHaveLength(1);
	}
	await expect(getItems(akahu(status(404)).c, "/me", User)).rejects.toMatchObject({ _tag: "ResponseStatusError", status: 404 });
	// A 400 carries Akahu's reason, which names the bad input; it is not retried.
	const bad = akahu(status(400));
	await expect(getItems(bad.c, "/me", User)).rejects.toThrow("Akahu rejected the request (400): synthetic");
	expect(bad.requests).toHaveLength(1);

	// Jittered exponential delays stay within 50–100% of 250 ms × 2^attempt; Retry-After wins but is capped.
	expect([retryDelay(0, null, () => 0), retryDelay(0, null, () => 1), retryDelay(2, null, () => 0), retryDelay(2, null, () => 1)]).toEqual([125, 250, 500, 1000]);
	expect([retryDelay(0, "2"), retryDelay(0, "120"), retryDelay(1, "soon", () => 0)]).toEqual([2000, 10_000, 250]);
});

// Minimal AppCache: never expires, which is enough to observe hits, keys and invalidation.
function memoryCache(loaderFetch: Akahu["fetch"]) {
	const store = new Map<string, unknown>();
	const cache: AppCache = {
		get: async ({ key, load }) => {
			const k = JSON.stringify(key);
			if (!store.has(k)) store.set(k, await load({ cache, fetch: loaderFetch as typeof fetch, signal: new AbortController().signal }));
			return store.get(k) as never;
		},
		revalidate: async () => { throw new Error("unused"); },
		read: async (key) => store.get(JSON.stringify(key)) as never,
		readMany: async (keys) => keys.map((key) => store.get(JSON.stringify(key))) as never,
		write: async (entries) => { for (const { key, value } of entries) store.set(JSON.stringify(key), value); },
		invalidate: async (key) => { store.delete(JSON.stringify(key)); },
		forAccount: () => cache,
	};
	return cache;
}

test("accounts and transaction pages are cached until a refresh request invalidates them", async () => {
	const pages = () => [Response.json({ items: [row("trans_1")], cursor: { next: "p2" } }), Response.json({ items: [row("trans_2")], cursor: { next: null } })];
	const other = Response.json({ items: [], cursor: { next: null } });
	const { c, requests } = akahu(Response.json({ items: [account] }), ...pages(), other, Response.json({ items: [account] }), ...pages());
	const cached = { ...c, cache: memoryCache(c.fetch) };
	const range = { start: "2026-10-01T00:00:00Z", end: "2026-10-31T23:59:59.999Z" };

	for (let i = 0; i < 2; i++) {
		expect((await fetchAccounts(cached)).map((a) => a._id)).toEqual(["acc_1"]);
		expect((await fetchTransactions(cached, range)).map((t) => t._id)).toEqual(["trans_1", "trans_2"]);
	}
	expect(requests).toHaveLength(3);
	// A different range is a different key.
	expect(await fetchTransactions(cached, { ...range, end: "2026-10-30T00:00:00Z" })).toEqual([]);
	expect(requests).toHaveLength(4);
	requests.length = 0;

	await invalidateCache(cached);
	expect((await fetchAccounts(cached)).map((a) => a._id)).toEqual(["acc_1"]);
	expect((await fetchTransactions(cached, range)).map((t) => t._id)).toEqual(["trans_1", "trans_2"]);
	expect(requests).toEqual([
		"GET /v1/accounts",
		"GET /v1/transactions?start=2026-09-30T23%3A59%3A59.999Z&end=2026-10-31T23%3A59%3A59.999Z",
		"GET /v1/transactions?start=2026-09-30T23%3A59%3A59.999Z&end=2026-10-31T23%3A59%3A59.999Z&cursor=p2",
	]);
});

test("an unavailable cache falls back to Akahu, but loader failures still fail", async () => {
	const cacheError = Object.assign(new Error("CacheError"), { _tag: "CacheError" });
	const ok = akahu(Response.json({ items: [account] }));
	const broken = { ...memoryCache(ok.c.fetch), read: async () => { throw cacheError; } };
	expect((await fetchAccounts({ ...ok.c, cache: broken })).map((a) => a._id)).toEqual(["acc_1"]);
	await invalidateCache({ ...ok.c, cache: broken });

	const failing = akahu(status(401));
	await expect(fetchAccounts({ ...failing.c, cache: memoryCache(failing.c.fetch) })).rejects.toMatchObject({ reason: "unauthorized" });
	expect(failing.requests).toHaveLength(1);
});
