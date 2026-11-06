// Transaction flows, ported from the NZ Account Thread mobile app
// (mobile/src/utils/classifyTransaction.ts and providers.ts) so agents, the dashboard and the
// phone agree on what counts as spending. Nothing here calls Akahu or the database.
import { nzDay, type Row } from "./analysis.js";
import type { Account, Transaction } from "./schemas.js";

export const FLOWS = ["spending", "income", "transfer", "saving"] as const;
export type Flow = (typeof FLOWS)[number];
// A rule sets a flow, or leaves matches out of every insight (exclude, which mobile lacks).
export const RULE_KINDS: readonly string[] = [...FLOWS, "exclude"];

export type RuleMatch = { description?: string; merchant?: string; other_account?: string; account_id?: string; direction?: string };
export type Rule = { id: string; kind: string; match: RuleMatch; reason?: string };

// The user's own call on one transaction, ahead of every rule. null puts it back to automatic,
// and also masks a decision saved on the classic transaction an official one replaced.
export type Decision = { flow: Flow; paired_id?: string } | null;
export type Decisions = ReadonlyMap<string, Decision>;

export type ReviewReason = "transfer" | "provider" | "category" | "reviewed";
export type Classified = Row & {
	flow: Flow | "excluded";
	rule_id?: string;
	// Why a person might disagree: the evidence mobile's review inbox shows.
	review?: { reason: ReviewReason; related_id?: string };
};

// A decision follows a transaction through official open banking migration (new id, _migrated).
export function decisionFor(t: Transaction, decisions: Decisions): Decision | undefined {
	return decisions.has(t._id) ? decisions.get(t._id) : t._migrated !== undefined ? decisions.get(t._migrated) : undefined;
}

const SAVING_ACCOUNT_TYPES = new Set(["KIWISAVER", "INVESTMENT", "TERMDEPOSIT"]);
const BROAD_SAVING_CATEGORY = "Financial services (not elsewhere classified)";
const SAVING_CATEGORIES = new Set(["Financial asset brokers, exchanges, and managed funds", BROAD_SAVING_CATEGORY]);

const contains = (value: string | undefined, needle: string) => (value ?? "").toLowerCase().includes(needle.toLowerCase());
// Account numbers are compared without dashes or spaces.
const alnum = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// account_id also matches the classic account an official-open-banking account replaced.
export function ruleMatches(r: RuleMatch, t: Transaction, migratedFrom?: string) {
	return (r.description === undefined || contains(t.description, r.description)) &&
		(r.merchant === undefined || (t.merchant !== undefined && contains(t.merchant.name, r.merchant))) &&
		(r.other_account === undefined || (alnum(t.meta?.other_account) !== "" && alnum(t.meta?.other_account).includes(alnum(r.other_account)))) &&
		(r.account_id === undefined || t._account === r.account_id || (migratedFrom !== undefined && migratedFrom === r.account_id)) &&
		(r.direction === undefined || (r.direction === "debit" ? t.amount < 0 : t.amount > 0));
}

export const merchantKey = (m: NonNullable<Transaction["merchant"]>) => m._id ?? `name:${m.name.toLowerCase()}`;

const GENERIC_TOKENS = new Set(["ltd", "limited", "inc", "corp", "company", "the", "and", "for", "pty", "plc", "new", "zealand", "nzd", "trust", "group"]);
const tokenize = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));

// Each saving provider's name as aliases ("Acorn Investments" → acorn, investments). An alias
// two providers share is ambiguous and dropped.
export function providerAliases(merchants: Iterable<NonNullable<Transaction["merchant"]>>) {
	const providers = new Map<string, Set<string>>();
	for (const m of merchants) if (!providers.has(merchantKey(m))) providers.set(merchantKey(m), new Set(tokenize(m.name)));
	const owners = new Map<string, number>();
	for (const aliases of providers.values()) for (const a of aliases) owners.set(a, (owners.get(a) ?? 0) + 1);
	for (const aliases of providers.values()) for (const a of aliases) if (owners.get(a)! > 1) aliases.delete(a);
	return providers;
}

// Providers return money as bare credits with no merchant: attribute one to the single provider
// whose alias its description contains. None or several matches attribute nothing.
export function matchProvider(t: Transaction, providers: ReadonlyMap<string, Set<string>>) {
	if (t.amount <= 0 || t.merchant) return undefined;
	const desc = t.description.toLowerCase();
	let match: string | undefined;
	for (const [id, aliases] of providers) {
		for (const a of aliases) {
			if (!desc.includes(a)) continue;
			if (match) return undefined;
			match = id;
			break;
		}
	}
	return match;
}

// Same NZ day, two different accounts, opposite amounts within half a cent, same currency:
// money moved between the user's own accounts. Each credit pairs with at most one debit.
function transferPairs(rows: readonly Row[]) {
	const pairs = new Map<string, string>();
	const byDay = new Map<string, Row[]>();
	for (const t of rows) byDay.set(nzDay(t.date), [...(byDay.get(nzDay(t.date)) ?? []), t]);
	for (const day of byDay.values()) {
		const credits = day.filter((t) => t.amount > 0);
		for (const d of day.filter((t) => t.amount < 0)) {
			const c = credits.find((c) => !pairs.has(c._id) && c._account !== d._account && c.currency === d.currency && Math.abs(c.amount + d.amount) < 0.005);
			if (c) { pairs.set(d._id, c._id); pairs.set(c._id, d._id); }
		}
	}
	return pairs;
}

/**
 * Give every settled row a flow. First match wins:
 *   -. the user's saved decision on that transaction (review.decide);
 *   0. the user's first matching rule (a flow, or exclude);
 *   1. account type: KiwiSaver, investment and term deposit are saving; loans are transfers;
 *   2. a same-day, opposite-amount pair across two accounts is a transfer;
 *   3. Akahu type: FEE and TAX are spending, INTEREST income or spending by sign, LOAN a transfer;
 *   4. a debit in a financial-services category is saving;
 *   5. a merchant-less credit naming exactly one saving provider is saving (a withdrawal);
 *   6. otherwise debits are spending and credits income.
 * Classify all of the user's accounts together, then narrow to the accounts in question, so a
 * transfer keeps its other side.
 */
export function classify(rows: readonly Row[], accounts: readonly Account[], rules: readonly Rule[], decisions: Decisions = new Map()): Classified[] {
	const accountOf = new Map(accounts.map((a) => [a._id, a]));
	const pairs = transferPairs(rows);
	const savingDebit = (t: Transaction) => t.amount < 0 && SAVING_CATEGORIES.has(t.category?.name ?? "");
	const providers = providerAliases(rows.flatMap((t) => (savingDebit(t) && t.merchant ? [t.merchant] : [])));
	const providerPayment = new Map(rows.flatMap((t) => (savingDebit(t) && t.merchant ? [[merchantKey(t.merchant), t._id] as const] : [])));

	return rows.map((t): Classified => {
		const decision = decisionFor(t, decisions);
		if (decision) return { ...t, flow: decision.flow, review: { reason: "reviewed", related_id: decision.paired_id } };
		const account = accountOf.get(t._account);
		const rule = rules.find((r) => ruleMatches(r.match, t, account?._migrated));
		if (rule) return { ...t, flow: rule.kind === "exclude" ? "excluded" : (rule.kind as Flow), rule_id: rule.id };
		if (account && SAVING_ACCOUNT_TYPES.has(account.type)) return { ...t, flow: "saving" };
		if (account?.type === "LOAN") return { ...t, flow: "transfer" };
		const pair = pairs.get(t._id);
		if (pair) return { ...t, flow: "transfer", review: { reason: "transfer", related_id: pair } };
		if (t.type === "FEE" || t.type === "TAX") return { ...t, flow: "spending" };
		if (t.type === "INTEREST") return { ...t, flow: t.amount >= 0 ? "income" : "spending" };
		if (t.type === "LOAN") return { ...t, flow: "transfer" };
		if (savingDebit(t)) return { ...t, flow: "saving", ...(t.category!.name === BROAD_SAVING_CATEGORY && { review: { reason: "category" } }) };
		const provider = matchProvider(t, providers);
		if (provider) return { ...t, flow: "saving", review: { reason: "provider", related_id: providerPayment.get(provider) } };
		return { ...t, flow: t.amount < 0 ? "spending" : "income" };
	});
}

// How many rows each rule decided, for tools to report.
export function rulesApplied(rows: readonly Classified[]) {
	const counts = new Map<string, number>();
	for (const t of rows) if (t.rule_id) counts.set(t.rule_id, (counts.get(t.rule_id) ?? 0) + 1);
	return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([rule_id, count]) => ({ rule_id, count }));
}

export const REVIEW_REASONS: Record<ReviewReason, string> = {
	transfer: "Matched by amount and date only",
	provider: "Provider name match only",
	category: "Broad financial-services category",
	reviewed: "Your saved decision",
};

export type ReviewCase = { id: string; reason: ReviewReason; transactions: Classified[]; evidence?: Classified };

/**
 * The mobile app's review inbox: rows whose flow rests on a guess (a transfer pair matched by
 * amount and date, a provider name, a broad category) or on the user's decision. A pair is one
 * case with both sides. Build from every account's rows, then keep cases with a row inScope, so
 * a transfer's other side stays visible. Newest first.
 */
export function reviewCases(rows: readonly Classified[], inScope: (t: Classified) => boolean): ReviewCase[] {
	const byId = new Map<string, Classified>();
	for (const t of rows) {
		byId.set(t._id, t);
		if (t._migrated) byId.set(t._migrated, t);
	}
	const pointsBack = (t: Classified, other: Classified | undefined): other is Classified =>
		other !== undefined && other.review?.reason === t.review?.reason && (t.review?.reason === "transfer" || t.review?.reason === "reviewed") &&
		other.review?.related_id !== undefined && byId.get(other.review.related_id)?._id === t._id;
	const seen = new Set<string>();
	const cases: ReviewCase[] = [];
	for (const t of rows) {
		if (!t.review || seen.has(t._id)) continue;
		const related = t.review.related_id === undefined ? undefined : byId.get(t.review.related_id);
		// A guessed pair whose other side is not in view is never offered for confirmation.
		if (t.review.reason === "transfer" && !related) continue;
		const transactions = pointsBack(t, related) ? [t, related] : [t];
		for (const row of transactions) seen.add(row._id);
		if (!transactions.some(inScope)) continue;
		cases.push({
			id: transactions.map((row) => row._id).sort().join(":"),
			reason: t.review.reason,
			transactions,
			...(transactions.length === 1 && related && { evidence: related }),
		});
	}
	return cases.sort((a, b) => b.transactions[0]!.date.localeCompare(a.transactions[0]!.date));
}

/**
 * The mobile app's virtual accounts: each saving provider (a merchant paid on a saving-flow
 * debit) with what was paid in and taken out. Merchant-less credits are attributed by provider
 * alias; a row the user decided is not saving is never attributed back.
 */
export function investmentContributions(rows: readonly Classified[]) {
	const merchants = new Map<string, NonNullable<Transaction["merchant"]>>();
	for (const t of rows) if (t.flow === "saving" && t.merchant && !merchants.has(merchantKey(t.merchant))) merchants.set(merchantKey(t.merchant), t.merchant);
	const providers = providerAliases(merchants.values());
	const buckets = new Map<string, Classified[]>();
	for (const t of rows) {
		if (t.review?.reason === "reviewed" && t.flow !== "saving") continue;
		const id = t.merchant && merchants.has(merchantKey(t.merchant)) ? merchantKey(t.merchant) : matchProvider(t, providers);
		if (!id) continue;
		const key = `${id}|${t.currency}`;
		buckets.set(key, [...(buckets.get(key) ?? []), t]);
	}
	return [...buckets].map(([key, txns]) => {
		const [id, currency] = key.split("|") as [string, string];
		const paid_in = txns.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
		const withdrawn = txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
		txns.sort((a, b) => b.date.localeCompare(a.date));
		return { provider: merchants.get(id)!.name, aliases: [...providers.get(id)!].sort(), currency, paid_in, withdrawn, net_contributed: paid_in - withdrawn, transactions: txns };
	}).sort((a, b) => Math.abs(b.net_contributed) - Math.abs(a.net_contributed));
}
