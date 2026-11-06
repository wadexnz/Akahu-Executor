import { array, boolean, number, object, query, router, string } from "apps";
import { fetchTransactions, getItem, getItems, fetchAccounts } from "../client.js";
import { Empty, PendingTransaction, Transaction, Txn } from "../schemas.js";
import { client, groupCurrencies, READ, round, txn, type Ctx } from "./context.js";

const getTransactions = query(
	{
		title: "Get transactions",
		description:
			"Settled transactions, newest first, with merchant, category and enrichment (particulars/code/reference/other_account/card_suffix/fx). Optional filters: start/end (inclusive ISO 8601 timestamps; omit for all available history), account_id, type (exact, e.g. EFTPOS), category/merchant/description (case-insensitive substring), min_amount/max_amount (absolute value in each account's currency), limit (default 500). Amounts are negative for money out. currencies contains net totals of returned rows only, separated by account currency with no FX conversion. unknown_currency_transaction_ids identifies returned rows excluded from totals because currency is unavailable.",
		input: object({
			start: string().optional(),
			end: string().optional(),
			account_id: string().optional(),
			type: string().optional(),
			category: string().optional(),
			merchant: string().optional(),
			description: string().optional(),
			min_amount: number().optional(),
			max_amount: number().optional(),
			limit: number().default(500),
		}),
		output: object({
			count: number(), truncated: boolean(), transactions: array(Txn),
			currencies: array(object({ currency: string(), net_total: number() })),
			unknown_currency_transaction_ids: array(string()),
		}),
		annotations: READ,
	},
	async (ctx: Ctx, i) => {
		if (!Number.isInteger(i.limit) || i.limit < 1) throw new Error("limit must be a positive integer");
		const has = (value: string | undefined, needle: string | undefined) =>
			needle === undefined || (value ?? "").toLowerCase().includes(needle.toLowerCase());
		const rows = await fetchTransactions(
			client(ctx),
			{ start: i.start, end: i.end },
			{
				accountId: i.account_id,
				limit: i.limit + 1,
				filter: (t) =>
					(i.type === undefined || t.type === i.type.toUpperCase()) &&
					(i.category === undefined || (t.category !== undefined && has(t.category.name, i.category))) &&
					(i.merchant === undefined || (t.merchant !== undefined && has(t.merchant.name, i.merchant))) &&
					has(t.description, i.description) &&
					(i.min_amount === undefined || Math.abs(t.amount) >= i.min_amount) &&
					(i.max_amount === undefined || Math.abs(t.amount) <= i.max_amount),
			},
		);
		const shown = rows.slice(0, i.limit);
		const { groups, unknown_currency_transaction_ids } = groupCurrencies(shown, await fetchAccounts(client(ctx)));
		return {
			count: shown.length,
			truncated: rows.length > i.limit,
			currencies: groups.map(([currency, rows]) => ({ currency, net_total: round(rows.reduce((sum, t) => sum + t.amount, 0)) })),
			unknown_currency_transaction_ids,
			transactions: shown.map(txn),
		};
	},
);

const getTransaction = query(
	{
		title: "Get transaction",
		description: "Fetch one settled transaction by id (trans_...).",
		input: object({ transaction_id: string({ minLength: 1 }) }),
		output: Txn,
		annotations: READ,
	},
	async (ctx: Ctx, { transaction_id }) =>
		txn(await getItem(client(ctx), `/transactions/${encodeURIComponent(transaction_id)}`, Transaction)),
);

const getPendingTransactions = query(
	{
		title: "Get pending transactions",
		description: "List pending (not yet settled) transactions across connected accounts.",
		input: Empty,
		output: array(Txn),
		annotations: READ,
	},
	async (ctx: Ctx) => (await getItems(client(ctx), "/transactions/pending", PendingTransaction)).map(txn),
);

const getTransactionSummary = query(
	{
		title: "Summarise transactions",
		description:
			"Totals of settled transactions separated by account currency, then grouped by category, merchant or type (group_by, default category), for an optional start/end range and account_id. No FX conversion. unknown_currency_transaction_ids identifies rows counted but excluded from totals because currency is unavailable. spending_only excludes money in; debits include transfers, not mobile spending classifications. Groups are sorted most negative first.",
		input: object({
			start: string().optional(),
			end: string().optional(),
			group_by: string().default("category"),
			account_id: string().optional(),
			spending_only: boolean().default(false),
		}),
		output: object({
			group_by: string(),
			transaction_count: number(),
			unknown_currency_transaction_ids: array(string()),
			currencies: array(object({
				currency: string(), transaction_count: number(),
				total_spending: number(), total_income: number(),
				groups: array(object({ name: string(), count: number(), total: number() })),
			})),
		}),
		annotations: READ,
	},
	async (ctx: Ctx, i) => {
		if (!["category", "merchant", "type"].includes(i.group_by)) throw new Error("group_by must be category, merchant or type");
		const rows = await fetchTransactions(
			client(ctx),
			{ start: i.start, end: i.end },
			{ accountId: i.account_id, filter: i.spending_only ? (t) => t.amount < 0 : undefined },
		);
		const { groups: currencies, unknown_currency_transaction_ids } = groupCurrencies(rows, await fetchAccounts(client(ctx)));
		return {
			group_by: i.group_by,
			transaction_count: rows.length,
			unknown_currency_transaction_ids,
			currencies: currencies.map(([currency, rows]) => {
				const groups = new Map<string, { count: number; total: number }>();
				for (const t of rows) {
					const key =
						i.group_by === "category" ? (t.category?.name ?? "Uncategorised") :
						i.group_by === "merchant" ? (t.merchant?.name ?? "Unknown") : t.type;
					const g = groups.get(key) ?? { count: 0, total: 0 };
					g.count++;
					g.total += t.amount;
					groups.set(key, g);
				}
				return {
					currency, transaction_count: rows.length,
					total_spending: round(rows.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)),
					total_income: round(rows.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)),
					groups: [...groups]
						.sort((a, b) => a[1].total - b[1].total)
						.map(([name, g]) => ({ name, count: g.count, total: round(g.total) })),
				};
			}),
		};
	},
);

export const transactions = router(
	{ search: getTransactions, get: getTransaction, pending: getPendingTransactions, summary: getTransactionSummary },
	{
		title: "Transactions",
		description: "Settled and pending transactions, filtered lists and grouped totals.",
		instructions: "start and end are inclusive ISO 8601 timestamps. Personal Apps see up to two years of history from when the app was created, and some banks keep less. Many banks only supply a date, so times are often midnight. Pending transactions have no id, merchant or category and can change before they settle. Settled results may be up to 15 minutes old.",
	},
);
