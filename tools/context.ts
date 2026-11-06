import type { MutationContext, QueryContext } from "apps";
import type { Akahu } from "../client.js";
import { akahu } from "../provider.js";
import type { Account, PendingTransaction, Transaction } from "../schemas.js";

export const requirements = { user: { accounts: { akahu } } };
export type Ctx = QueryContext<typeof requirements> | MutationContext<typeof requirements>;

export function client(ctx: Ctx): Akahu {
	const account = ctx.user.accounts.akahu;
	return { fetch: ctx.fetch, headers: account.headers(), signal: ctx.signal, cache: ctx.cache.forAccount(account) };
}

// Compact transaction for agents: Akahu enrichment flattened, absent fields omitted.
export function txn(t: Transaction | PendingTransaction) {
	const m = t.meta;
	return {
		...("_id" in t ? { id: t._id } : { pending: true }),
		account_id: t._account,
		date: t.date,
		description: t.description,
		amount: t.amount,
		type: t.type,
		...(t.balance !== undefined && { balance: t.balance }),
		...(t.merchant && { merchant: t.merchant.name }),
		...(t.category && { category: t.category.name }),
		...(t.category?.groups?.personal_finance && { category_group: t.category.groups.personal_finance.name }),
		...(m?.particulars && { particulars: m.particulars }),
		...(m?.code && { code: m.code }),
		...(m?.reference && { reference: m.reference }),
		...(m?.other_account && { other_account: m.other_account }),
		...(m?.card_suffix && { card_suffix: m.card_suffix }),
		...(m?.conversion && { fx: m.conversion }),
	};
}

export const round = (n: number) => Math.round(n * 100) / 100;

// Account currency is the unit of the settled amount, not the original FX purchase.
// Missing metadata must never silently turn an amount into NZD (or a mixed total).
export function groupCurrencies(rows: Transaction[], accounts: readonly Account[]) {
	const byId = new Map(accounts.map(a => [a._id, a.balance?.currency]));
	const groups = new Map<string, Transaction[]>();
	const unknown_currency_transaction_ids: string[] = [];
	for (const t of rows) {
		const currency = byId.get(t._account);
		if (!currency) {
			unknown_currency_transaction_ids.push(t._id);
			continue;
		}
		const group = groups.get(currency) ?? [];
		group.push(t);
		groups.set(currency, group);
	}
	return { groups: [...groups].sort(([a], [b]) => a.localeCompare(b)), unknown_currency_transaction_ids };
}

// Every tool reads Akahu, an external service whose text fields (descriptions,
// references, merchant names) are written by third parties: openWorldHint.
export const READ = { readOnlyHint: true, openWorldHint: true } as const;
