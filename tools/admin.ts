import { array, boolean, mutation, object, router, string } from "apps";
import { always } from "apps/operations/approval";
import { invalidateCache, post } from "../client.js";
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
		const c = client(ctx);
		await post(c, account_id ? `/refresh/${encodeURIComponent(account_id)}` : "/refresh");
		await invalidateCache(c);
		return { requested: account_id ?? "all" };
	},
);

const ISSUE_TYPES = ["DUPLICATE", "ENRICHMENT_ERROR", "ENRICHMENT_SUGGESTION"];

const reportEnrichmentIssue = mutation(
	{
		title: "Report a transaction data problem to Akahu",
		description:
			"Send Akahu a support report about one settled transaction (trans_...). type: DUPLICATE (other_id is the duplicate transaction id, required), ENRICHMENT_ERROR (fields lists the wrong values as dot paths such as merchant.name or category.name) or ENRICHMENT_SUGGESTION. comment explains the problem in plain words. Akahu staff read these; it does not change the transaction immediately. Only report what the user has confirmed.",
		input: object({
			transaction_id: string({ minLength: 1 }),
			type: string(),
			other_id: string({ minLength: 1 }).optional(),
			fields: array(string({ minLength: 1 })).optional(),
			comment: string().optional(),
		}),
		output: object({ reported: boolean(), transaction_id: string(), type: string() }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		approval: always(),
	},
	async (ctx: Ctx, { transaction_id, type, other_id, fields, comment }) => {
		if (!ISSUE_TYPES.includes(type)) throw new Error(`type must be one of ${ISSUE_TYPES.join(", ")}`);
		if (type === "DUPLICATE" && other_id === undefined) throw new Error("A DUPLICATE report needs other_id, the duplicate transaction's id");
		await post(client(ctx), `/support/${encodeURIComponent(transaction_id)}`, {
			type, ...(other_id !== undefined && { other_id }), ...(fields !== undefined && { fields }), ...(comment !== undefined && { comment }),
		});
		return { reported: true, transaction_id, type };
	},
);

export const admin = router({ refresh: refreshAccounts, reportEnrichmentIssue }, {
	title: "Admin",
	description: "Requests that change state at Akahu; each needs the user's approval.",
	instructions: "Only refresh when the user asks for up-to-date data. Akahu already syncs daily and ignores, or rate-limits, a refresh within an hour of the last one. A refresh only starts a bank sync; new data can take minutes to appear. Use reportEnrichmentIssue only for a problem the user has confirmed, such as a wrong merchant or a duplicated transaction.",
});
