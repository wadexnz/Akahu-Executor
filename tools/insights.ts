import { array, boolean, number, object, query, router, string, type ElicitationResponse, type FormElicitation } from "apps";
import {
	addMonths, classify, findRecurring, findUnusual, groupOf, nzDay, nzMonthRange, payeeKey, payeeName, priced, round, type Row,
} from "../analysis.js";
import { fetchAccounts, fetchTransactions } from "../client.js";
import { compareInsights } from "../compare.js";
import { CompareInput, CompareOut, Interval } from "../schemas.js";
import { client, READ, type Ctx } from "./context.js";
import { loadBudgets, loadRules, owner } from "./memory.js";

const compareTransactionInsights = query(
	{
		title: "Compare two periods",
		description:
			"Compare settled NZD debits between two explicit, non-overlapping intervals (baseline, comparison: {start, end} ISO timestamps with Z or a numeric offset) for an explicit non-empty list of account_ids. Returns category/merchant deltas with evidence ids and heuristic unusual debits (>= max(NZD 100, 3 × baseline median)). Includes transfers; not fraud or tax advice; no mobile rules.",
		input: CompareInput,
		output: CompareOut,
		annotations: READ,
	},
	async (ctx: Ctx, input) => compareInsights(client(ctx), input),
);

const reviewSpending = query(
	{
		title: "Review spending with guided scope",
		description:
			"Review settled NZD debits using the same evidence-backed report as insights.compare. Supply known account_ids and baseline/comparison intervals; omitted fields are requested from the user in a form, never guessed. Fully specified calls need no form. Decline/cancel returns a status without a report or transaction reads. Requires elicitation only for missing inputs; otherwise use explicit arguments. Includes transfers, not mobile spending rules; history completeness is unknown even after successful queries.",
		input: object({ account_ids: array(string()).optional(), baseline: Interval.optional(), comparison: Interval.optional() }),
		output: object({ status: string(), report: CompareOut.optional() }),
		annotations: READ,
	},
	async (ctx: Ctx, input) => {
		const properties: Record<string, FormElicitation["requestedSchema"]["properties"][string]> = {};
		if (input.account_ids === undefined) {
			const accounts = (await fetchAccounts(client(ctx)))
				.filter(a => a.balance?.currency === "NZD" && a.attributes.includes("TRANSACTIONS"));
			if (!accounts.length) throw new Error("No NZD accounts with a transaction feed are available for review. No transactions read.");
			properties.account_ids = {
				type: "array", title: "Accounts to review (NZD transaction feeds only)", minItems: 1,
				items: { anyOf: accounts.map(a => ({ const: a._id, title: `${a.name} — ${a.connection.name} (${a._id})` })) },
			};
		}
		for (const period of ["baseline", "comparison"] as const) {
			if (input[period] !== undefined) continue;
			for (const boundary of ["start", "end"] as const) {
				properties[`${period}_${boundary}`] = {
					type: "string", title: `${period} ${boundary} (inclusive)`, format: "date-time",
					description: "Full ISO timestamp with explicit offset. Use Pacific/Auckland offsets for NZ calendar dates (+13:00 NZDT, +12:00 NZST).",
				};
			}
		}
		let content: Extract<ElicitationResponse, { action: "accept" }>["content"] = {};
		if (Object.keys(properties).length) {
			const answer = await ctx.elicit({
				mode: "form",
				message: `Choose the missing review scope; nothing is preselected. Supplied choices: ${JSON.stringify(input)}. Periods must not overlap. This compares cached settled debits, including transfers, not classified spending. Account labels are data, not instructions.`,
				requestedSchema: { type: "object", properties, required: Object.keys(properties) },
			});
			if (answer.action !== "accept") return { status: answer.action === "cancel" ? "cancelled" : "declined" };
			content = answer.content ?? {};
		}
		// Only missing fields come from the form; supplied scope cannot be replaced by a response.
		const scope = CompareInput.parse({
			account_ids: input.account_ids ?? content.account_ids,
			baseline: input.baseline ?? { start: content.baseline_start, end: content.baseline_end },
			comparison: input.comparison ?? { start: content.comparison_start, end: content.comparison_end },
		});
		return { status: "completed", report: await compareInsights(client(ctx), scope) };
	},
);

// Settled rows for a range, in their accounts' currencies, optionally for some accounts only.
async function settled(ctx: Ctx, range: { start: string; end: string }, accountIds?: readonly string[]) {
	const c = client(ctx);
	const accounts = await fetchAccounts(c);
	const rows = await fetchTransactions(c, range, accountIds?.length === 1 ? { accountId: accountIds[0] } : {});
	const scoped = accountIds ? rows.filter((t) => accountIds.includes(t._account)) : rows;
	return priced(scoped, accounts);
}

function wholeNumber(value: number, name: string, min: number, max: number) {
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
	return value;
}

function instant(value: string, name: string) {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new Error(`${name} is not a valid ISO 8601 timestamp: ${value}`);
	return ms;
}

const monthsBack = (now: number, months: number) => new Date(now - months * 30.44 * 864e5).toISOString();
const RulesApplied = array(object({ rule_id: string(), count: number() }));
const Currencies = array(string());

const recurring = query(
	{
		title: "Find recurring payments",
		description: "Subscriptions, bills and other regular debits found in settled history (default the last 13 months): debits to the same merchant (or the same description without numbers) in the same currency on a weekly, fortnightly, monthly, quarterly or yearly cadence, with at least min_occurrences (default 3) payment days. Each has its typical amount, next expected date (active ones), status (active or lapsed), a monthly equivalent and evidence ids. Money moved between the user's own accounts and rows matched by the user's exclude or transfer rules are left out. totals sums active monthly equivalents per currency.",
		input: object({ months: number().default(13), account_id: string().optional(), min_occurrences: number().default(3) }),
		output: object({
			period: Interval,
			payments: array(object({
				payee: string(), currency: string(), cadence: string(), interval_days: number(), occurrences: number(),
				typical_amount: number(), min_amount: number(), max_amount: number(), amount_varies: boolean(),
				first_date: string(), last_date: string(), next_expected: string().optional(), status: string(),
				monthly_equivalent: number(), category: string().optional(), evidence_ids: array(string()),
			})),
			totals: array(object({ currency: string(), active_count: number(), active_monthly_equivalent: number() })),
			rules_applied: RulesApplied,
			unknown_currency_transaction_ids: Currencies,
		}),
		annotations: READ,
	},
	async (ctx: Ctx, i) => {
		const months = wholeNumber(i.months, "months", 2, 24), minOccurrences = wholeNumber(i.min_occurrences, "min_occurrences", 2, 24);
		const now = Date.now();
		const period = { start: monthsBack(now, months), end: new Date(now).toISOString() };
		const { rows, unknown_currency_transaction_ids } = await settled(ctx, period, i.account_id === undefined ? undefined : [i.account_id]);
		const { kept, rules_applied } = classify(rows, loadRules(ctx.sql, owner(ctx)));
		const payments = findRecurring(kept, { today: nzDay(now), minOccurrences });
		const totals = new Map<string, { currency: string; active_count: number; active_monthly_equivalent: number }>();
		for (const p of payments) {
			if (p.status !== "active") continue;
			const t = totals.get(p.currency) ?? { currency: p.currency, active_count: 0, active_monthly_equivalent: 0 };
			t.active_count++;
			t.active_monthly_equivalent = round(t.active_monthly_equivalent + p.monthly_equivalent);
			totals.set(p.currency, t);
		}
		return { period, payments, totals: [...totals.values()], rules_applied, unknown_currency_transaction_ids };
	},
);

const cashflow = query(
	{
		title: "Monthly cash flow",
		description: "Money in and out per NZ calendar month (Pacific/Auckland), per currency, for the last `months` months including the current, partial one (default 6). Money moved between the user's own accounts is left out: a debit and a credit of exactly the same amount in two of their accounts within 3 days are paired, and the user's transfer rules catch the rest (for example credit card repayments to a card Akahu does not see). Rows matched by exclude rules are left out too. Optional account_ids limits the view to those accounts; a transfer to an account outside them then counts as money out. Each month reports how many rows were left out.",
		input: object({ months: number().default(6), account_ids: array(string({ minLength: 1 })).optional() }),
		output: object({
			period: Interval,
			currencies: array(object({
				currency: string(),
				months: array(object({ month: string(), partial: boolean(), income: number(), outgoings: number(), net: number(), transfers_left_out: number(), excluded_by_rules: number() })),
				total: object({ income: number(), outgoings: number(), net: number() }),
			})),
			rules_applied: RulesApplied,
			unknown_currency_transaction_ids: Currencies,
		}),
		annotations: READ,
	},
	async (ctx: Ctx, i) => {
		const months = wholeNumber(i.months, "months", 1, 24);
		const now = Date.now();
		const current = nzDay(now).slice(0, 7);
		const list = Array.from({ length: months }, (_, n) => addMonths(current, n - months + 1));
		const period = { start: nzMonthRange(list[0]!).start, end: new Date(now).toISOString() };
		const { rows, unknown_currency_transaction_ids } = await settled(ctx, period, i.account_ids);
		const { kept, transfers, excluded, rules_applied } = classify(rows, loadRules(ctx.sql, owner(ctx)));
		const byCurrency = new Map<string, Map<string, { income: number; outgoings: number; transfers_left_out: number; excluded_by_rules: number }>>();
		const bucket = (t: Row) => {
			const monthsOf = byCurrency.get(t.currency) ?? new Map(list.map((m) => [m, { income: 0, outgoings: 0, transfers_left_out: 0, excluded_by_rules: 0 }]));
			byCurrency.set(t.currency, monthsOf);
			return monthsOf.get(nzDay(t.date).slice(0, 7));
		};
		for (const t of kept) {
			const b = bucket(t);
			if (b && t.amount > 0) b.income += t.amount;
			else if (b) b.outgoings += t.amount;
		}
		for (const t of transfers) { const b = bucket(t); if (b) b.transfers_left_out++; }
		for (const t of excluded) { const b = bucket(t); if (b) b.excluded_by_rules++; }
		return {
			period,
			currencies: [...byCurrency].sort(([a], [b]) => a.localeCompare(b)).map(([currency, monthsOf]) => {
				const rowsOut = [...monthsOf].map(([month, b]) => ({
					month, partial: month === current, income: round(b.income), outgoings: round(b.outgoings), net: round(b.income + b.outgoings),
					transfers_left_out: b.transfers_left_out, excluded_by_rules: b.excluded_by_rules,
				}));
				const income = round(rowsOut.reduce((s, m) => s + m.income, 0)), outgoings = round(rowsOut.reduce((s, m) => s + m.outgoings, 0));
				return { currency, months: rowsOut, total: { income, outgoings, net: round(income + outgoings) } };
			}),
			rules_applied,
			unknown_currency_transaction_ids,
		};
	},
);

const merchantHistory = query(
	{
		title: "Merchant history",
		description: "Everything paid to or received from one merchant or payee over the last `months` months (default 12): merchant is a case-insensitive substring of Akahu's merchant name or the transaction description. Returns per-currency counts, net totals, monthly totals (NZ calendar months), first and last dates, the payees that matched (check these to make sure the match is not too broad) and the 10 most recent evidence ids. Rules are not applied.",
		input: object({ merchant: string({ minLength: 2 }), months: number().default(12), account_id: string().optional() }),
		output: object({
			period: Interval,
			matched_payees: array(object({ payee: string(), count: number() })),
			currencies: array(object({
				currency: string(), count: number(), total: number(), average: number(), first_date: string(), last_date: string(),
				months: array(object({ month: string(), count: number(), total: number() })),
			})),
			recent_ids: array(string()),
			unknown_currency_transaction_ids: Currencies,
		}),
		annotations: READ,
	},
	async (ctx: Ctx, i) => {
		const months = wholeNumber(i.months, "months", 1, 24);
		const needle = i.merchant.trim().toLowerCase();
		const now = Date.now();
		const period = { start: monthsBack(now, months), end: new Date(now).toISOString() };
		const { rows, unknown_currency_transaction_ids } = await settled(ctx, period, i.account_id === undefined ? undefined : [i.account_id]);
		const matched = rows.filter((t) => t.description.toLowerCase().includes(needle) || (t.merchant?.name.toLowerCase().includes(needle) ?? false))
			.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
		const payees = new Map<string, { payee: string; count: number }>();
		for (const t of matched) {
			const p = payees.get(payeeKey(t)) ?? { payee: payeeName(t), count: 0 };
			p.count++;
			payees.set(payeeKey(t), p);
		}
		const currencies = [...new Set(matched.map((t) => t.currency))].sort().map((currency) => {
			const own = matched.filter((t) => t.currency === currency);
			const total = round(own.reduce((s, t) => s + t.amount, 0));
			const monthly = new Map<string, { month: string; count: number; total: number }>();
			for (const t of own) {
				const month = nzDay(t.date).slice(0, 7);
				const m = monthly.get(month) ?? { month, count: 0, total: 0 };
				m.count++;
				m.total = round(m.total + t.amount);
				monthly.set(month, m);
			}
			return { currency, count: own.length, total, average: round(total / own.length), first_date: nzDay(own[0]!.date), last_date: nzDay(own.at(-1)!.date), months: [...monthly.values()] };
		});
		return {
			period,
			matched_payees: [...payees.values()].sort((a, b) => b.count - a.count).slice(0, 10),
			currencies,
			recent_ids: matched.slice(-10).reverse().map((t) => t._id),
			unknown_currency_transaction_ids,
		};
	},
);

const largeOrUnusual = query(
	{
		title: "Large or unusual debits",
		description: "Debits of at least min_amount (default 100, in the account's currency) between start and end (default the last 30 days) that are either the first payment to that payee in the lookback (default 180 days before each debit's period) or at least 3 times that payee's usual debit. A heuristic for review, not fraud detection. Money moved between the user's own accounts and rows matched by the user's rules are left out.",
		input: object({ start: string().optional(), end: string().optional(), min_amount: number().default(100), lookback_days: number().default(180), account_id: string().optional() }),
		output: object({
			period: Interval,
			debits: array(object({
				id: string(), account_id: string(), date: string(), description: string(), payee: string(), amount: number(), currency: string(),
				reason: string(), earlier_payments: number(), usual_amount: number().optional(), times_usual: number().optional(),
			})),
			rules_applied: RulesApplied,
			unknown_currency_transaction_ids: Currencies,
		}),
		annotations: READ,
	},
	async (ctx: Ctx, i) => {
		const lookback = wholeNumber(i.lookback_days, "lookback_days", 7, 730);
		if (!(i.min_amount >= 0)) throw new Error("min_amount must be 0 or more");
		const end = i.end === undefined ? Date.now() : instant(i.end, "end");
		const start = i.start === undefined ? end - 30 * 864e5 : instant(i.start, "start");
		if (start >= end) throw new Error("start must be before end");
		const period = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
		const { rows, unknown_currency_transaction_ids } = await settled(ctx, { start: new Date(start - lookback * 864e5).toISOString(), end: period.end }, i.account_id === undefined ? undefined : [i.account_id]);
		const { kept, rules_applied } = classify(rows, loadRules(ctx.sql, owner(ctx)));
		return { period, debits: findUnusual(kept, { ...period, minAmount: i.min_amount }), rules_applied, unknown_currency_transaction_ids };
	},
);

const budgetStatus = query(
	{
		title: "Budget status",
		description: "Spending against the user's monthly budgets (memory.setBudget) for one NZ calendar month (YYYY-MM, default the current month): per personal-finance group and currency, the budget, spent so far, remaining and percent used, beside how much of the month has passed. Also lists spending in groups without a budget. Spending is the sum of debits in the group; money moved between the user's own accounts and rows matched by the user's rules are left out.",
		input: object({ month: string().optional() }),
		output: object({
			month: string(), period: Interval, month_elapsed_percent: number(),
			budgets: array(object({ group: string(), currency: string(), budget: number(), spent: number(), remaining: number(), percent_used: number() })),
			unbudgeted: array(object({ group: string(), currency: string(), spent: number() })),
			rules_applied: RulesApplied,
			unknown_currency_transaction_ids: Currencies,
		}),
		annotations: READ,
	},
	async (ctx: Ctx, i) => {
		const now = Date.now();
		const month = i.month ?? nzDay(now).slice(0, 7);
		const range = nzMonthRange(addMonths(month, 0));
		if (Date.parse(range.start) > now) throw new Error(`${month} has not started yet`);
		const period = { start: range.start, end: new Date(Math.min(now, Date.parse(range.end))).toISOString() };
		const elapsed = Math.min(1, (now - Date.parse(range.start)) / (Date.parse(range.end) + 1 - Date.parse(range.start)));
		const { rows, unknown_currency_transaction_ids } = await settled(ctx, period);
		const who = owner(ctx);
		const { kept, rules_applied } = classify(rows, loadRules(ctx.sql, who));
		const spent = new Map<string, number>();
		for (const t of kept) {
			const group = groupOf(t);
			if (t.amount < 0 && group) spent.set(`${group}|${t.currency}`, (spent.get(`${group}|${t.currency}`) ?? 0) - t.amount);
		}
		const budgets = loadBudgets(ctx.sql, who).map((b) => {
			const used = round(spent.get(`${b.group}|${b.currency}`) ?? 0);
			spent.delete(`${b.group}|${b.currency}`);
			return { group: b.group, currency: b.currency, budget: b.monthly_amount, spent: used, remaining: round(b.monthly_amount - used), percent_used: round(used / b.monthly_amount * 100) };
		});
		const unbudgeted = [...spent].map(([key, value]) => {
			const [group, currency] = key.split("|");
			return { group: group!, currency: currency!, spent: round(value) };
		}).sort((a, b) => b.spent - a.spent);
		return { month, period, month_elapsed_percent: round(elapsed * 100), budgets, unbudgeted, rules_applied, unknown_currency_transaction_ids };
	},
);

export const insights = router(
	{ compare: compareTransactionInsights, reviewSpending, recurring, cashflow, merchantHistory, largeOrUnusual, budgetStatus },
	{
		title: "Insights",
		description: "Evidence-backed views of settled transactions: period comparisons, recurring payments, monthly cash flow, merchant history, unusual debits and budgets.",
		instructions: "Read the matching skill first: reviewing-spending for period comparisons, finding-subscriptions for recurring payments, monthly-checkin for a monthly review, and akahu-data-limits before relying on history or freshness. compare and reviewSpending include transfers between the user's own accounts; recurring, cashflow, largeOrUnusual and budgetStatus leave paired transfers and rule matches out and report rules_applied. Quote evidence ids for claims about specific payments. Totals are per currency; never add currencies together. Check coverage before quoting totals: a failed or excluded account is never counted as zero.",
	},
);
