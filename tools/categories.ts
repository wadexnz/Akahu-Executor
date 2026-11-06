import { array, object, query, router, string } from "apps";
import { CATEGORIES, GROUPS, NZFCC_VERSION, resolveGroup } from "../categories.js";

const listCategories = query(
	{
		title: "List categories",
		description: `The NZ Financial Category Codes (NZFCC ${NZFCC_VERSION}) that Akahu uses to categorise transactions, bundled with the app (no Akahu request). Optional filters: group (personal-finance group, case-insensitive), direction (debit or credit), search (case-insensitive substring of the name). Only debit categories have a group. Use the names and groups as filters on transactions.search and transactions.summary.`,
		input: object({ group: string().optional(), direction: string().optional(), search: string().optional() }),
		output: object({
			version: string(),
			groups: array(string()),
			categories: array(object({ id: string(), name: string(), group: string().optional(), direction: string() })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: false },
	},
	async (_ctx, i) => {
		if (i.direction !== undefined && !["debit", "credit"].includes(i.direction)) throw new Error("direction must be debit or credit");
		const group = resolveGroup(i.group);
		const needle = i.search?.toLowerCase();
		return {
			version: NZFCC_VERSION,
			groups: [...GROUPS],
			categories: CATEGORIES
				.filter(([, name, g, direction]) =>
					(group === undefined || g === group) && (i.direction === undefined || direction === i.direction) &&
					(needle === undefined || name.toLowerCase().includes(needle)))
				.map(([id, name, g, direction]) => ({ id, name, ...(g && { group: g }), direction })),
		};
	},
);

export const categories = router({ list: listCategories }, {
	title: "Categories",
	description: "The NZFCC transaction categories and personal-finance groups Akahu uses.",
});
