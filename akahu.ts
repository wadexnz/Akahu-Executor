import { array, bearer, decodeJson, defineProvider, header, json, number, object, record, secrets, string, type Infer, type Schema } from "apps";

// Akahu Personal App credentials. Executor stores them; app code only ever holds
// handles, which Executor's network swaps for the real values on requests to
// api.akahu.io, and only as these two exact headers.
export const akahu = defineProvider({
	name: "Akahu Personal App",
	hosts: ["api.akahu.io"],
	auth: {
		personalApp: secrets({
			label: "Akahu Personal App tokens",
			fields: object({ "App ID Token": string({ minLength: 1 }), "User Access Token": string({ minLength: 1 }) }),
			request: ({ "App ID Token": appToken, "User Access Token": userToken }) => [header("x-akahu-id", appToken), bearer(userToken)],
		}),
	},
	async health({ account, fetch, signal }) {
		const response = await fetch(`${API}/me`, { signal, headers: account.headers() });
		const { item } = await decodeJson(response, object({ item: User }));
		const accountInfo = { externalId: item._id };
		if (item.email) return { accountInfo: { ...accountInfo, email: item.email } };
		return { accountInfo };
	},
});

export const API = "https://api.akahu.io/v1";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type Akahu = { fetch: Fetch; headers: Record<string, string>; signal: AbortSignal };

// Decode only fields the tools consume; Akahu may add other response fields.
const TransactionFields = {
	_account: string(),
	date: string(),
	description: string(),
	amount: number(),
	type: string(),
	balance: number().optional(),
	merchant: object({ name: string(), website: string().optional() }).optional(),
	category: object({ name: string(), groups: record(object({ name: string() })).optional() }).optional(),
	meta: object({
		particulars: string().optional(),
		code: string().optional(),
		reference: string().optional(),
		other_account: string().optional(),
		card_suffix: string().optional(),
		conversion: object({ amount: number(), currency: string(), rate: number() }).optional(),
	}).optional(),
};
export const Transaction = object({ _id: string(), ...TransactionFields });
export type Transaction = Infer<typeof Transaction>;
export const PendingTransaction = object({ ...TransactionFields, updated_at: string().optional() });
export type PendingTransaction = Infer<typeof PendingTransaction>;
export const Account = object({
	_id: string(),
	name: string(),
	status: string(),
	type: string(),
	attributes: array(string()),
	formatted_account: string().optional(),
	refreshed: record(string()).optional(),
	connection: object({ name: string() }),
	balance: object({ currency: string(), current: number(), available: number().optional() }).optional(),
});
export type Account = Infer<typeof Account>;
export const User = object({
	_id: string(), email: string().optional(), preferred_name: string().optional(), access_granted_at: string().optional(),
});

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

// Page through settled transactions. `filter` runs per page so `limit` counts
// matches, not raw rows.
export async function fetchTransactions(
	c: Akahu,
	range: { start?: string; end?: string },
	opts: { accountId?: string; limit?: number; filter?: (t: Transaction) => boolean } = {},
): Promise<Transaction[]> {
	const path = opts.accountId ? `/accounts/${encodeURIComponent(opts.accountId)}/transactions` : "/transactions";
	const matched: Transaction[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const r = await c.fetch(url(path, { ...range, cursor }), { headers: c.headers, signal: c.signal });
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
