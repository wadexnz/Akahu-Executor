import { array, decodeJson, json, number, object, ProviderError, string, type AppCache, type CacheGetOptions, type Schema } from "apps";
import { Account, Transaction } from "./schemas.js";

export const API = "https://api.akahu.io/v1";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
// `cache` is scoped to the caller's Akahu account (ctx.cache.forAccount).
export type Akahu = { fetch: Fetch; headers: Record<string, string>; signal: AbortSignal; cache?: AppCache };

function url(path: string, query: Record<string, string | undefined> = {}) {
	const u = new URL(`${API}${path}`);
	for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
	return u.toString();
}

// Akahu documents 401 for a revoked token, 403 for a missing app id, scope or IP
// allow-list, and asks clients to back off on 429. Bodies are never forwarded.
export async function decode<T>(r: Response, schema: Schema<T, boolean>): Promise<T> {
	const reason = r.status === 401 ? "unauthorized" : r.status === 403 ? "rejected" : r.status === 429 ? "rate_limited" :
		r.status >= 500 ? "unavailable" : undefined;
	if (reason) {
		await r.body?.cancel();
		throw new ProviderError({ reason, status: r.status });
	}
	return decodeJson(r, schema);
}

const RETRIES = 3, BASE_MS = 250, MAX_WAIT_MS = 10_000;

// Exponential backoff with jitter (250 ms, 500 ms, 1 s, each 50–100%), or the
// server's Retry-After when it is shorter than MAX_WAIT_MS.
export function retryDelay(attempt: number, retryAfter: string | null, random = Math.random) {
	const seconds = retryAfter === null ? NaN : Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
	const base = BASE_MS * 2 ** attempt;
	return base / 2 + random() * base / 2;
}

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const done = () => { signal.removeEventListener("abort", abort); resolve(); };
		const timer = setTimeout(done, ms);
		const abort = () => { clearTimeout(timer); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
	});
}

// Reads retry on 429. Writes do not: a rate-limited refresh is reported, not repeated.
async function get(c: Akahu, target: string) {
	for (let attempt = 0; ; attempt++) {
		const r = await c.fetch(target, { headers: c.headers, signal: c.signal });
		if (r.status !== 429 || attempt >= RETRIES) return r;
		await r.body?.cancel();
		await sleep(retryDelay(attempt, r.headers.get("retry-after")), c.signal);
	}
}

export async function getItems<T>(c: Akahu, path: string, item: Schema<T, boolean>): Promise<T[]> {
	return [...(await decode(await get(c, url(path)), object({ items: array(item) }))).items];
}

export async function getItem<T>(c: Akahu, path: string, item: Schema<T, boolean>): Promise<T> {
	return (await decode(await get(c, url(path)), object({ item }))).item;
}

export async function post(c: Akahu, path: string): Promise<void> {
	const r = await c.fetch(url(path), {
		method: "POST",
		headers: { ...c.headers, "idempotency-key": crypto.randomUUID() },
		signal: c.signal,
	});
	await decode(r, object({}));
}

// Cache keys include a generation that admin.refresh bumps, so data cached before
// a refresh request is not served afterwards. A cache that is unavailable (for
// example the local test host) only costs extra requests; it never fails a tool.
const Generation = ["generation"];

async function cached<T>(c: Akahu, key: (string | null)[], schema: Schema<T, boolean>, freshFor: CacheGetOptions<T>["freshFor"], load: (c: Akahu) => Promise<T>) {
	const cache = c.cache;
	if (!cache) return load(c);
	try {
		const generation = (await cache.read(Generation, number())) ?? 0;
		return await cache.get({
			key: [...key, generation], schema, freshFor, stale: "revalidate",
			load: ({ fetch, signal }) => load({ ...c, fetch, signal }),
		});
	} catch (error) {
		if ((error as { _tag?: unknown } | null)?._tag === "CacheError") return load(c);
		throw error;
	}
}

export async function invalidateCache(c: Akahu) {
	if (!c.cache) return;
	try {
		const generation = (await c.cache.read(Generation, number())) ?? 0;
		await c.cache.write([{ key: Generation, value: generation + 1 }], "7 days");
	} catch (error) {
		if ((error as { _tag?: unknown } | null)?._tag !== "CacheError") throw error;
	}
}

// Balances move with every bank sync; Akahu syncs daily or on request.
export function fetchAccounts(c: Akahu) {
	return cached(c, ["accounts"], array(Account), "5 minutes", (c) => getItems(c, "/accounts", Account));
}

// Akahu treats `start` as exclusive (millisecond resolution); tools take inclusive
// starts, so ask for one millisecond earlier. Bank dates are often exactly midnight.
function exclusiveStart(start: string) {
	const ms = Date.parse(start);
	if (Number.isNaN(ms)) throw new Error(`start is not a valid ISO 8601 timestamp: ${start}`);
	return new Date(ms - 1).toISOString();
}

const Page = object({ items: array(Transaction), next: string().optional() });

// Page through settled transactions. `filter` runs per page so `limit` counts
// matches, not raw rows. Each raw page is cached for 15 minutes.
export async function fetchTransactions(
	c: Akahu,
	range: { start?: string; end?: string },
	opts: { accountId?: string; limit?: number; filter?: (t: Transaction) => boolean } = {},
): Promise<Transaction[]> {
	const path = opts.accountId ? `/accounts/${encodeURIComponent(opts.accountId)}/transactions` : "/transactions";
	const query = { start: range.start === undefined ? undefined : exclusiveStart(range.start), end: range.end };
	const matched: Transaction[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await cached(c, ["transactions", path, query.start ?? null, query.end ?? null, cursor ?? null], Page, "15 minutes", async (c) => {
			const body = await decode(await get(c, url(path, { ...query, cursor })), object({
				items: array(Transaction), cursor: object({ next: json().optional() }).optional(),
			}));
			const next = body.cursor?.next;
			return { items: [...body.items], ...(next != null && { next: string().parse(next) }) };
		});
		for (const t of page.items) {
			if (opts.filter && !opts.filter(t)) continue;
			matched.push(t);
			if (opts.limit && matched.length >= opts.limit) return matched;
		}
		cursor = page.next;
		if (cursor !== undefined) {
			if (seen.has(cursor)) throw new Error("Akahu repeated a history cursor");
			seen.add(cursor);
		}
	} while (cursor !== undefined);
	return matched;
}
