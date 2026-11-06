import { fetchAccounts, fetchTransactions, type Akahu } from "./client.js";
import type { Transaction } from "./schemas.js";

export type Interval = { start: string; end: string };
const round = (n: number) => Math.round(n * 100) / 100;

// API boundaries are inclusive; filter defensively and deduplicate page overlap.
export function scopedRows(rows: Transaction[], accountId: string, range: Interval) {
	return [...new Map(rows.filter(t => t._account === accountId &&
		Date.parse(t.date) >= Date.parse(range.start) && Date.parse(t.date) <= Date.parse(range.end))
		.map(t => [t._id, t])).values()];
}

export function compareRows(baseline: Transaction[], comparison: Transaction[]) {
	const debits = (rows: Transaction[]) => rows.filter(t => t.amount < 0);
	const before = debits(baseline), after = debits(comparison);
	const total = (rows: Transaction[]) => round(rows.reduce((sum, t) => sum - t.amount, 0));
	const deltas = (field: "category" | "merchant") => {
		const group = (rows: Transaction[]) => {
			const groups = new Map<string, Transaction[]>();
			for (const t of rows) {
				const key = field === "category"
					? ("category" in t && t.category ? t.category.name : "Uncategorised")
					: ("merchant" in t && t.merchant ? t.merchant.name : "Unknown merchant");
				const bucket = groups.get(key) ?? [];
				bucket.push(t);
				groups.set(key, bucket);
			}
			return groups;
		};
		const a = group(before), b = group(after);
		return [...new Set([...a.keys(), ...b.keys()])].sort().map(name => {
			const oldRows = a.get(name) ?? [], newRows = b.get(name) ?? [];
			const oldTotal = total(oldRows), newTotal = total(newRows);
			return { name, baseline_debits: oldTotal, comparison_debits: newTotal,
				delta: round(newTotal - oldTotal), percent_change: oldTotal ? round((newTotal - oldTotal) / oldTotal * 100) : null,
				baseline_count: oldRows.length, comparison_count: newRows.length,
				baseline_ids: oldRows.map(t => t._id), comparison_ids: newRows.map(t => t._id) };
		});
	};
	const amounts = before.map(t => -t.amount).sort((a, b) => a - b);
	const middle = Math.floor(amounts.length / 2);
	const median = amounts.length ? (amounts.length % 2 ? amounts[middle]! : (amounts[middle - 1]! + amounts[middle]!) / 2) : null;
	const threshold = amounts.length >= 3 ? Math.max(100, 3 * median!) : null;
	return {
		baseline: { settled_count: baseline.length, debit_count: before.length, debits: total(before) },
		comparison: { settled_count: comparison.length, debit_count: after.length, debits: total(after) },
		category_deltas: deltas("category"), merchant_deltas: deltas("merchant"),
		heuristic: { rule: "Comparison debit magnitude >= max(NZD 100, 3 × pooled baseline debit median); requires at least 3 baseline debits. Includes transfers; not fraud or tax advice.",
			baseline_median: median, threshold, baseline_evidence_ids: before.map(t => t._id),
			status: threshold === null ? "insufficient_baseline" : "evaluated" },
		unusual_debits: threshold === null ? [] : after.filter(t => -t.amount >= threshold).map(t => ({
			id: t._id, account_id: t._account, date: t.date, description: t.description,
			debit: -t.amount, type: t.type, reason: "Debit magnitude meets the disclosed threshold" })),
	};
}

const OFFSET_ISO = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// Rejects bare dates, missing offsets and impossible calendar days such as 30 February.
function validTimestamp(v: string) {
	const m = OFFSET_ISO.exec(v);
	if (!m || Number.isNaN(Date.parse(v))) return false;
	const day = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
	return day.getUTCMonth() === +m[2]! - 1 && day.getUTCDate() === +m[3]!;
}

// Explicitly scoped, read-only comparison of settled NZD debits in two intervals.
export async function compareInsights(client: Akahu, { account_ids, baseline, comparison }: { account_ids: readonly string[]; baseline: Interval; comparison: Interval }) {
	const ids = [...new Set(account_ids)];
	if (ids.length === 0 || ids.some((id) => !/^acc_[A-Za-z0-9]+$/.test(id))) throw new Error("account_ids must be a non-empty list of acc_... ids");
	for (const v of [baseline.start, baseline.end, comparison.start, comparison.end]) {
		if (!validTimestamp(v)) throw new Error(`Invalid timestamp ${v}; use ISO 8601 with Z or a numeric offset`);
	}
	const a = Date.parse(baseline.start), b = Date.parse(baseline.end);
	const c = Date.parse(comparison.start), d = Date.parse(comparison.end);
	if (!(a < b && c < d)) throw new Error("Each interval must have start before end.");
	if (!(b < c || d < a)) throw new Error("Inclusive intervals must not overlap or share an endpoint.");
	const accounts = await fetchAccounts(client);
	const included: string[] = [];
	const excluded: { account_id: string; reason: string }[] = [];
	const before: Transaction[] = [], after: Transaction[] = [];
	for (const id of ids) {
		const account = accounts.find((x) => x._id === id);
		const reason = !account ? "Account unavailable; no automatic migration or scope widening" :
			account.balance?.currency !== "NZD" ? `Currency ${account.balance?.currency ?? "unknown"}; excluded, no FX conversion` :
			!account.attributes.includes("TRANSACTIONS") ? "Transaction feed unavailable in account attributes" : null;
		if (reason) { excluded.push({ account_id: id, reason }); continue; }
		try {
			const oldRows = await fetchTransactions(client, baseline, { accountId: id });
			const newRows = await fetchTransactions(client, comparison, { accountId: id });
			before.push(...scopedRows(oldRows, id, baseline));
			after.push(...scopedRows(newRows, id, comparison));
			included.push(id);
		} catch {
			excluded.push({ account_id: id, reason: "Transaction query failed; excluded from both intervals, not treated as zero" });
		}
	}
	return {
		currency: "NZD",
		scope: { requested_account_ids: ids, included_account_ids: included, excluded_accounts: excluded, baseline, comparison },
		account_metadata: accounts.filter((x) => included.includes(x._id)).map((x) => ({ account_id: x._id, status: x.status, refreshed: x.refreshed ?? null })),
		coverage: included.length === 0 ? "unavailable" : excluded.length ? "partial" : "queried",
		elapsed_seconds: { baseline: (b - a) / 1000, comparison: (d - c) / 1000, mismatch: b - a !== d - c },
		limitations: [
			"Raw totals are not normalised for elapsed-window differences; offsets are explicit, no implicit NZ calendar conversion.",
			"Negative amounts are debits, not classified spending. Transfers remain included; mobile local rules and transfer pairing are not used.",
			"Akahu cached settled history only; pending excluded. Successful queries or empty results do not prove history completeness or feed availability. No bank refresh requested.",
			"INACTIVE describes inability to refresh, not absence of cached history; cached rows may still be queried.",
			"Category/merchant grouping uses Akahu names with missing-enrichment buckets. Percent change is null when baseline is zero.",
		],
		...compareRows(before, after),
	};
}
