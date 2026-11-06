import { array, number, object, query, router, string } from "apps";
import { fetchAccounts, getItem } from "../client.js";
import { Account, AccountOut, Empty } from "../schemas.js";
import { client, READ, type Ctx } from "./context.js";

function accountOut(a: Account) {
	return {
		id: a._id,
		bank: a.connection.name,
		name: a.name,
		...(a.formatted_account && { number: a.formatted_account }),
		type: a.type,
		status: a.status,
		has_transactions: a.attributes.includes("TRANSACTIONS"),
		...(a.balance && {
			balance: {
				currency: a.balance.currency, current: a.balance.current, available: a.balance.available ?? a.balance.current,
				...(a.balance.limit !== undefined && { limit: a.balance.limit }),
				...(a.balance.overdrawn !== undefined && { overdrawn: a.balance.overdrawn }),
			},
		}),
		...(a.connection.connection_type && { connection_type: a.connection.connection_type }),
		...(a.refreshed && { refreshed: a.refreshed }),
	};
}

export const listAccounts = query(
	{
		title: "List accounts",
		description: "List connected NZ bank accounts with balances, status and transaction-feed availability.",
		input: Empty,
		output: array(AccountOut),
		annotations: READ,
	},
	async (ctx: Ctx) => (await fetchAccounts(client(ctx))).map(accountOut),
);

const getAccount = query(
	{
		title: "Get account",
		description: "One connected account by id (acc_...), fetched live from Akahu rather than from the 5-minute account cache.",
		input: object({ account_id: string({ minLength: 1 }) }),
		output: AccountOut,
		annotations: READ,
	},
	async (ctx: Ctx, { account_id }) => accountOut(await getItem(client(ctx), `/accounts/${encodeURIComponent(account_id)}`, Account)),
);

// Akahu syncs Personal App data daily; older than this suggests a sync problem.
const STALE_HOURS = 36;
const Synced = object({ at: string(), age_hours: number().optional() });

const accountFreshness = query(
	{
		title: "Check data freshness",
		description: `When Akahu last synced each account's balance, metadata, transactions and identity data, with plain warnings for INACTIVE accounts, transactions never synced, and balances or transactions older than ${STALE_HOURS} hours. Use before trusting totals or when data looks out of date.`,
		input: Empty,
		output: object({
			checked_at: string(),
			accounts: array(object({
				id: string(), name: string(), bank: string(), status: string(), connection_type: string().optional(),
				refreshed: object({ balance: Synced.optional(), meta: Synced.optional(), transactions: Synced.optional(), party: Synced.optional() }),
				warnings: array(string()),
			})),
		}),
		annotations: READ,
	},
	async (ctx: Ctx) => {
		const now = Date.now();
		const synced = (at: string | undefined) => {
			if (at === undefined) return undefined;
			const ms = Date.parse(at);
			return Number.isNaN(ms) ? { at } : { at, age_hours: Math.round((now - ms) / 36e5 * 10) / 10 };
		};
		return {
			checked_at: new Date(now).toISOString(),
			accounts: (await fetchAccounts(client(ctx))).map((a) => {
				const refreshed = {
					...(a.refreshed?.balance && { balance: synced(a.refreshed.balance) }),
					...(a.refreshed?.meta && { meta: synced(a.refreshed.meta) }),
					...(a.refreshed?.transactions && { transactions: synced(a.refreshed.transactions) }),
					...(a.refreshed?.party && { party: synced(a.refreshed.party) }),
				};
				const warnings: string[] = [];
				if (a.status === "INACTIVE") warnings.push("INACTIVE: Akahu can no longer sync this account. Cached data is kept; reconnect it at my.akahu.nz.");
				if (a.attributes.includes("TRANSACTIONS") && !refreshed.transactions) warnings.push("Transactions have not been synced yet.");
				for (const part of ["balance", "transactions"] as const) {
					const age = refreshed[part]?.age_hours;
					if (age !== undefined && age > STALE_HOURS) warnings.push(`${part === "balance" ? "Balance" : "Transactions"} last synced ${Math.round(age)} hours ago; Akahu normally syncs daily.`);
				}
				return {
					id: a._id, name: a.name, bank: a.connection.name, status: a.status,
					...(a.connection.connection_type && { connection_type: a.connection.connection_type }),
					refreshed, warnings,
				};
			}),
		};
	},
);

export const accounts = router({ list: listAccounts, get: getAccount, freshness: accountFreshness }, {
	title: "Accounts",
	description: "Connected bank accounts, balances and feed status.",
	instructions: "Balances are in each account's own currency; a negative balance is money owed (credit cards, loans). refreshed shows when Akahu last synced each part of the account, usually daily; accounts.freshness turns that into ages and warnings. An INACTIVE account can no longer sync but keeps its cached history. accounts.list and accounts.freshness may be up to 5 minutes old; accounts.get is live. connection_type official means the bank's official open banking API, which supplies less detail (for example no loan details, and dates without times).",
});
