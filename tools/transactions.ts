import { array, boolean, number, object, query, router, string } from "apps";
import { groupOf } from "../analysis.js";
import { resolveGroup } from "../categories.js";
import { AkahuRejected, fetchAccounts, fetchTransactions, getItem, getItems, postRead } from "../client.js";
import { PendingTransaction, Transaction, Txn } from "../schemas.js";
import { client, groupCurrencies, READ, round, txn, type Ctx } from "./context.js";
import { annotationsFor, owner, taggedIds } from "./memory.js";

// Settled rows with the user's own notes and tags from this app's memory.
function annotated(ctx: Ctx, rows: readonly Transaction[]) {
	const memo = annotationsFor(ctx.sql, owner(ctx), rows.map((t) => t._id));
	return rows.map((t) => {
		const m = memo.get(t._id);
		return { ...txn(t), ...(m?.note !== undefined && { note: m.note }), ...(m?.tags.length && { tags: m.tags }) };
	});
}

const getTransactions = query(
	{
		title: "Get transactions",
		description:
			"Settled transactions, newest first, with merchant, category and enrichment (particulars/code/reference/other_account/card_suffix/fx). Optional filters: start/end (inclusive ISO 8601 timestamps; omit for all available history), account_id, type (exact, e.g. EFTPOS), category/merchant/description (case-insensitive substring), group (personal-finance category group such as Food or Transport; see categories.list), tag (one of the user's memory tags), min_amount/max_amount (absolute value in each account's currency), limit (default 500). Amounts are negative for money out. currencies contains net totals of returned rows only, separated by account currency with no FX conversion. unknown_currency_transaction_ids identifies returned rows excluded from totals because currency is unavailable. Rows carry the user's note and tags when they have any.",
		input: object({
			start: string().optional(),
			end: string().optional(),
			account_id: string().optional(),
			type: string().optional(),
			category: string().optional(),
			merchant: string().optional(),
			description: string().optional(),
			group: string().optional(),
			tag: string().optional(),
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
		const group = resolveGroup(i.group);
		const tagged = i.tag === undefined ? undefined : taggedIds(ctx.sql, owner(ctx), i.tag);
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
					(group === undefined || groupOf(t) === group) &&
					(tagged === undefined || tagged.has(t._id)) &&
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
			transactions: annotated(ctx, shown),
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
		annotated(ctx, [await getItem(client(ctx), `/transactions/${encodeURIComponent(transaction_id)}`, Transaction)])[0]!,
);

const getPendingTransactions = query(
	{
		title: "Get pending transactions",
		description: "Pending (not yet settled) transactions across connected accounts, or for one account_id. Always live. Pending rows have no id, merchant or category, and can change or disappear before they settle.",
		input: object({ account_id: string({ minLength: 1 }).optional() }),
		output: array(Txn),
		annotations: READ,
	},
	async (ctx: Ctx, { account_id }) => {
		const path = account_id ? `/accounts/${encodeURIComponent(account_id)}/transactions/pending` : "/transactions/pending";
		return (await getItems(client(ctx), path, PendingTransaction)).map(txn);
	},
);

const MAX_IDS = 100;

const getManyTransactions = query(
	{
		title: "Get transactions by id",
		description: `Fetch up to ${MAX_IDS} settled transactions by id (trans_...) in one request, for example the evidence ids in an insights report. missing_ids lists ids Akahu did not return: the transaction may have been deleted, or re-issued under a new id when the bank changed it or the account moved to official open banking. A malformed id (not a complete trans_... id) fails the whole request.`,
		input: object({ transaction_ids: array(string({ minLength: 1 })) }),
		output: object({ transactions: array(Txn), missing_ids: array(string()) }),
		annotations: READ,
	},
	async (ctx: Ctx, { transaction_ids }) => {
		const ids = [...new Set(transaction_ids)];
		if (ids.length === 0 || ids.length > MAX_IDS) throw new Error(`transaction_ids must contain 1 to ${MAX_IDS} distinct ids`);
		const { items } = await postRead(client(ctx), "/transactions/ids", ids, object({ items: array(Transaction) })).catch((error: unknown) => {
			if (!(error instanceof AkahuRejected)) throw error;
			throw new Error(`${error.message}. One malformed id makes Akahu reject the whole batch: use complete trans_... ids exactly as transactions.search returned them.`);
		});
		const found = new Set(items.map((t) => t._id));
		return { transactions: annotated(ctx, items), missing_ids: ids.filter((id) => !found.has(id)) };
	},
);

const getTransactionSummary = query(
	{
		title: "Summarise transactions",
		description:
			"Totals of settled transactions separated by account currency, then grouped by category, personal-finance group, merchant or type (group_by: category (default), group, merchant or type), for an optional start/end range, account_id and group filter. No FX conversion. unknown_currency_transaction_ids identifies rows counted but excluded from totals because currency is unavailable. spending_only excludes money in; debits include transfers, not mobile spending classifications. Groups are sorted most negative first.",
		input: object({
			start: string().optional(),
			end: string().optional(),
			group_by: string().default("category"),
			account_id: string().optional(),
			group: string().optional(),
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
		if (!["category", "group", "merchant", "type"].includes(i.group_by)) throw new Error("group_by must be category, group, merchant or type");
		const group = resolveGroup(i.group);
		const rows = await fetchTransactions(
			client(ctx),
			{ start: i.start, end: i.end },
			{ accountId: i.account_id, filter: (t) => (!i.spending_only || t.amount < 0) && (group === undefined || groupOf(t) === group) },
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
						i.group_by === "group" ? (groupOf(t) ?? "Ungrouped") :
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
	{ search: getTransactions, get: getTransaction, getMany: getManyTransactions, pending: getPendingTransactions, summary: getTransactionSummary },
	{
		title: "Transactions",
		description: "Settled and pending transactions, filtered lists and grouped totals.",
		instructions: "start and end are inclusive ISO 8601 timestamps. Personal Apps see up to two years of history from when the app was created, and some banks keep less. Many banks only supply a date, so times are often midnight. Pending transactions have no id, merchant or category and can change before they settle. Settled results may be up to 15 minutes old.",
	},
);
