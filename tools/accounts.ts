import { array, query, router } from "apps";
import { fetchAccounts } from "../client.js";
import { AccountOut, Empty } from "../schemas.js";
import { client, READ, type Ctx } from "./context.js";

const listAccounts = query(
	{
		title: "List accounts",
		description: "List connected NZ bank accounts with balances, status and transaction-feed availability.",
		input: Empty,
		output: array(AccountOut),
		annotations: READ,
	},
	async (ctx: Ctx) =>
		(await fetchAccounts(client(ctx))).map((a) => ({
			id: a._id,
			bank: a.connection.name,
			name: a.name,
			...(a.formatted_account && { number: a.formatted_account }),
			type: a.type,
			status: a.status,
			has_transactions: a.attributes.includes("TRANSACTIONS"),
			...(a.balance && {
				balance: { currency: a.balance.currency, current: a.balance.current, available: a.balance.available ?? a.balance.current },
			}),
			...(a.refreshed && { refreshed: a.refreshed }),
		})),
);

export const accounts = router({ list: listAccounts }, {
	title: "Accounts",
	description: "Connected bank accounts, balances and feed status.",
	instructions: "Balances are in each account's own currency; a negative balance is money owed (credit cards, loans). refreshed shows when Akahu last synced each part of the account, usually daily. An INACTIVE account can no longer sync but keeps its cached history. Results may be up to 5 minutes old.",
});
