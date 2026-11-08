// Pure analysis over settled transactions: NZ calendar dates, recurring payments and unusual
// debits (flows are in classify.ts). Nothing here calls Akahu or the database.
import type { Account, Transaction } from "./schemas.js";

export const round = (n: number) => Math.round(n * 100) / 100;

export function median(values: readonly number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const NZ = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit" });

// The NZ calendar day (YYYY-MM-DD) of an instant.
export function nzDay(at: string | number) {
	const p = Object.fromEntries(NZ.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
	return `${p.year}-${p.month}-${p.day}`;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function addMonths(month: string, n: number) {
	const m = MONTH.exec(month);
	if (!m) throw new Error(`month must look like 2026-11, not ${month}`);
	return new Date(Date.UTC(+m[1]!, +m[2]! - 1 + n, 1)).toISOString().slice(0, 7);
}

export function addDays(day: string, n: number) {
	return new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

// The instant an NZ calendar day starts. NZ changes its clocks at 2 or 3am, so midnight
// always exists, at +13:00 (NZDT) or +12:00 (NZST).
export function nzStartOf(day: string) {
	const [y, m, d] = day.split("-").map(Number);
	for (const offset of [13, 12]) {
		const t = Date.UTC(y!, m! - 1, d!) - offset * 36e5;
		if (nzDay(t) === day && nzDay(t - 1) !== day) return new Date(t).toISOString();
	}
	throw new Error(`Not a calendar day: ${day}`);
}

// The start of the NZ day `days` days before the day of `now`. Default range starts use it so
// they stay the same all day and repeated reads share cached Akahu pages.
export const nzDaysBefore = (now: number, days: number) => nzStartOf(addDays(nzDay(now), -days));

// The inclusive instant range of an NZ calendar month.
export function nzMonthRange(month: string) {
	return { start: nzStartOf(`${month}-01`), end: new Date(Date.parse(nzStartOf(`${addMonths(month, 1)}-01`)) - 1).toISOString() };
}

// A settled transaction in its account's currency. Rows whose account currency is unknown
// are reported, never counted.
export type Row = Transaction & { currency: string };

export function priced(rows: readonly Transaction[], accounts: readonly Account[]) {
	const currencyOf = new Map(accounts.map((a) => [a._id, a.balance?.currency]));
	const out: Row[] = [];
	const unknown_currency_transaction_ids: string[] = [];
	for (const t of rows) {
		const currency = currencyOf.get(t._account);
		if (currency) out.push({ ...t, currency });
		else unknown_currency_transaction_ids.push(t._id);
	}
	return { rows: out, unknown_currency_transaction_ids };
}

// Who a transaction was with: Akahu's merchant when enriched, otherwise the description
// without numbers and punctuation, so "NETFLIX 0123" and "NETFLIX 0456" agree.
export function payeeKey(t: Transaction) {
	if (t.merchant) return `m:${t.merchant.name.toLowerCase()}`;
	const words = t.description.toLowerCase().replace(/[^a-z]+/g, " ").trim();
	return `d:${words || t.description.trim().toLowerCase()}`;
}

export const payeeName = (t: Transaction) => t.merchant?.name ?? t.description;
export const groupOf = (t: Transaction) => t.category?.groups?.personal_finance?.name;

const CADENCES = [
	{ name: "weekly", days: 7, min: 6, max: 8 },
	{ name: "fortnightly", days: 14, min: 12, max: 16 },
	{ name: "monthly", days: 30.44, min: 26, max: 35 },
	{ name: "quarterly", days: 91.31, min: 84, max: 98 },
	{ name: "yearly", days: 365.25, min: 350, max: 380 },
];

// Debits to the same payee in the same currency on a regular cadence. At least 60% of the
// gaps between payment days must fit the cadence, so an occasional extra payment is tolerated.
export function findRecurring(rows: readonly Row[], { today, minOccurrences }: { today: string; minOccurrences: number }) {
	const groups = new Map<string, Row[]>();
	for (const t of rows) {
		if (t.amount >= 0) continue;
		const key = `${t.currency}|${payeeKey(t)}`;
		groups.set(key, [...(groups.get(key) ?? []), t]);
	}
	const found = [];
	for (const group of groups.values()) {
		const sorted = group.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
		const days = [...new Set(sorted.map((t) => nzDay(t.date)))];
		if (days.length < minOccurrences) continue;
		const gaps = days.slice(1).map((day, i) => daysBetween(days[i]!, day));
		const interval = median(gaps);
		const cadence = CADENCES.find((c) => interval >= c.min && interval <= c.max);
		if (!cadence || gaps.filter((g) => g >= cadence.min && g <= cadence.max).length / gaps.length < 0.6) continue;
		const amounts = sorted.map((t) => -t.amount);
		const typical = median(amounts);
		const last = sorted.at(-1)!;
		const lastDay = days.at(-1)!;
		const active = daysBetween(lastDay, today) <= interval * 1.5 + 3;
		found.push({
			payee: payeeName(last),
			currency: last.currency,
			cadence: cadence.name,
			interval_days: interval,
			occurrences: sorted.length,
			typical_amount: -round(typical),
			min_amount: -round(Math.max(...amounts)),
			max_amount: -round(Math.min(...amounts)),
			amount_varies: Math.max(...amounts) - Math.min(...amounts) > typical * 0.1,
			first_date: days[0]!,
			last_date: lastDay,
			...(active && { next_expected: addDays(lastDay, Math.round(interval)) }),
			status: active ? "active" : "lapsed",
			monthly_equivalent: -round(typical * 30.44 / cadence.days),
			...(last.category && { category: last.category.name }),
			evidence_ids: sorted.slice(-5).map((t) => t._id),
		});
	}
	return found.sort((a, b) => a.monthly_equivalent - b.monthly_equivalent);
}

// Debits of at least minAmount in [start, end] that are the first to their payee in the
// fetched history, or at least three times that payee's usual debit.
export function findUnusual(rows: readonly Row[], { start, end, minAmount }: { start: string; end: string; minAmount: number }) {
	const sorted = rows.filter((t) => t.amount < 0).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
	const from = Date.parse(start), to = Date.parse(end);
	const history = new Map<string, number[]>();
	const found = [];
	for (const t of sorted) {
		const key = `${t.currency}|${payeeKey(t)}`;
		const prior = history.get(key) ?? [];
		const amount = -t.amount;
		const at = Date.parse(t.date);
		if (at >= from && at <= to && amount >= minAmount) {
			const usual = prior.length ? median(prior) : undefined;
			const reason = usual === undefined ? "first_payment_to_payee" : amount >= usual * 3 ? "large_for_payee" : undefined;
			if (reason) found.push({
				id: t._id, account_id: t._account, date: t.date, description: t.description, payee: payeeName(t),
				amount: t.amount, currency: t.currency, reason, earlier_payments: prior.length,
				...(usual !== undefined && { usual_amount: -round(usual), times_usual: round(amount / usual) }),
			});
		}
		history.set(key, [...prior, amount]);
	}
	return found.sort((a, b) => a.amount - b.amount);
}
