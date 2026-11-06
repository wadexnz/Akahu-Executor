import { mutation, object, router, string } from "apps";
import { always } from "apps/operations/approval";
import { post } from "../client.js";
import { client, type Ctx } from "./context.js";

const refreshAccounts = mutation(
	{
		title: "Refresh bank data",
		description:
			"Ask Akahu to re-fetch data from the banks. Pass account_id (acc_...) for one account, otherwise all. Personal Apps have a one-hour rest period, so a request inside it may not fetch anything new.",
		input: object({ account_id: string().optional() }),
		output: object({ requested: string() }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		approval: always(),
	},
	async (ctx: Ctx, { account_id }) => {
		await post(client(ctx), account_id ? `/refresh/${encodeURIComponent(account_id)}` : "/refresh");
		return { requested: account_id ?? "all" };
	},
);

export const admin = router({ refresh: refreshAccounts }, { title: "Admin", description: "Requests that change state at Akahu; each needs the user's approval." });
