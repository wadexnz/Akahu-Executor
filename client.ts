import { array, decodeJson, json, object, string, type Schema } from "apps";
import { API } from "./provider.js";
import { Transaction } from "./schemas.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Akahu = { fetch: Fetch; headers: Record<string, string>; signal: AbortSignal };

function url(path: string, query: Record<string, string | undefined> = {}) {
	const u = new URL(`${API}${path}`);
	for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
	return u.toString();
}

export async function getItems<T>(c: Akahu, path: string, item: Schema<T, boolean>): Promise<T[]> {
	const r = await c.fetch(url(path), { headers: c.headers, signal: c.signal });
	return [...(await decodeJson(r, object({ items: array(item) }))).items];
}

export async function getItem<T>(c: Akahu, path: string, item: Schema<T, boolean>): Promise<T> {
	const r = await c.fetch(url(path), { headers: c.headers, signal: c.signal });
	return (await decodeJson(r, object({ item }))).item;
}

export async function post(c: Akahu, path: string): Promise<void> {
	const r = await c.fetch(url(path), {
		method: "POST",
		headers: { ...c.headers, "idempotency-key": crypto.randomUUID() },
		signal: c.signal,
	});
	await decodeJson(r, object({}));
}

// Akahu treats `start` as exclusive (millisecond resolution); tools take inclusive
// starts, so ask for one millisecond earlier. Bank dates are often exactly midnight.
function exclusiveStart(start: string) {
	const ms = Date.parse(start);
	if (Number.isNaN(ms)) throw new Error(`start is not a valid ISO 8601 timestamp: ${start}`);
	return new Date(ms - 1).toISOString();
}

// Page through settled transactions. `filter` runs per page so `limit` counts
// matches, not raw rows.
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
		const r = await c.fetch(url(path, { ...query, cursor }), { headers: c.headers, signal: c.signal });
		const page = await decodeJson(r, object({
			items: array(Transaction), cursor: object({ next: json().optional() }).optional(),
		}));
		for (const t of page.items) {
			if (opts.filter && !opts.filter(t)) continue;
			matched.push(t);
			if (opts.limit && matched.length >= opts.limit) return matched;
		}
		const next = page.cursor?.next;
		cursor = next == null ? undefined : string().parse(next);
		if (cursor !== undefined) {
			if (seen.has(cursor)) throw new Error("Akahu repeated a history cursor");
			seen.add(cursor);
		}
	} while (cursor !== undefined);
	return matched;
}
