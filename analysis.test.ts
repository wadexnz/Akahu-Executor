import { expect, test } from "bun:test";
import { classify, findRecurring, findUnusual, nzDay, nzMonthRange, pairTransfers, type Row } from "./analysis.js";

let n = 0;
const row = (account: string, date: string, amount: number, extra: Partial<Row> = {}): Row => ({
	_id: `trans_${++n}`, _account: account, date, description: "Synthetic", amount, type: amount < 0 ? "DEBIT" : "CREDIT", currency: "NZD", ...extra,
});

test("NZ calendar days and months follow Pacific/Auckland, across daylight saving", () => {
	// 11:30 UTC on 30 September is 00:30 on 1 October in NZDT (+13).
	expect(nzDay("2026-09-30T11:30:00Z")).toBe("2026-10-01");
	expect(nzDay("2026-09-30T10:59:59Z")).toBe("2026-09-30");
	// October starts in NZDT; July in NZST (+12); April starts in NZDT and ends in NZST.
	expect(nzMonthRange("2026-10").start).toBe("2026-09-30T11:00:00.000Z");
	expect(nzMonthRange("2026-07").start).toBe("2026-06-30T12:00:00.000Z");
	expect(nzMonthRange("2026-04")).toEqual({ start: "2026-03-31T11:00:00.000Z", end: "2026-04-30T11:59:59.999Z" });
	expect(nzMonthRange("2026-12").end).toBe("2026-12-31T10:59:59.999Z");
});

test("transfers pair one debit with the closest same-amount credit in another account within 3 days", () => {
	const out = row("acc_a", "2026-10-10T00:00:00Z", -500);
	const near = row("acc_b", "2026-10-11T00:00:00Z", 500);
	const far = row("acc_c", "2026-10-13T12:00:00Z", 500); // 3.5 days: too far
	const sameAccount = row("acc_a", "2026-10-10T01:00:00Z", 500);
	const otherCurrency = row("acc_usd", "2026-10-10T01:00:00Z", 500, { currency: "USD" });
	const centsOff = row("acc_d", "2026-10-10T02:00:00Z", 500.01);
	const second = row("acc_a", "2026-10-10T00:00:00Z", -500); // only one credit left in range
	const paired = pairTransfers([out, near, far, sameAccount, otherCurrency, centsOff, second]);
	expect([...paired].sort()).toEqual([out._id, near._id].sort());
});

test("rules win over pairing, and a rule-matched row cannot pair with anything", () => {
	const repayment = row("acc_everyday", "2026-10-02T00:00:00Z", -300, { description: "CARD REPAYMENT 4111" });
	const cardCredit = row("acc_card", "2026-10-02T00:00:00Z", 300);
	const deposit = row("acc_everyday", "2026-10-03T00:00:00Z", -50000, { description: "House deposit" });
	const coffee = row("acc_everyday", "2026-10-04T00:00:00Z", -6);
	// Matches both rules: the older one (exclude) wins.
	const both = row("acc_everyday", "2026-10-05T00:00:00Z", -900, { description: "House deposit by card repayment" });
	const rules = [
		{ id: "rule_x", kind: "exclude", match: { description: "house deposit" } },
		{ id: "rule_t", kind: "transfer", match: { description: "card repayment", direction: "debit" } },
	];
	const result = classify([repayment, cardCredit, deposit, coffee, both], rules);
	expect(result.excluded.map((t) => t._id)).toEqual([deposit._id, both._id]);
	expect(result.transfers.map((t) => t._id)).toEqual([repayment._id]);
	// The card's credit stays: its debit side was claimed by the rule, so nothing pairs with it.
	expect(result.kept.map((t) => t._id)).toEqual([cardCredit._id, coffee._id]);
	expect(result.rules_applied).toEqual([{ rule_id: "rule_t", count: 1 }, { rule_id: "rule_x", count: 2 }]);
});

test("recurring payments need a regular cadence; irregular payees and stopped ones are told apart", () => {
	const merchant = (name: string) => ({ merchant: { name } });
	// Monthly on the 1st (gaps of 28–31 days), NZ midnight timestamps.
	const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
	const netflix = months.map((m) => row("acc_a", nzMonthRange(m).start, -22.99, merchant("Netflix")));
	// Weekly, with one price rise: typical is the median.
	const gym = [0, 7, 14, 21, 28, 35].map((d, i) => row("acc_a", new Date(Date.parse("2026-09-01T00:00:00Z") + d * 864e5).toISOString(), i < 4 ? -10 : -12, merchant("Gym")));
	// Same amounts, irregular gaps (3, 40, 9, 60 days): not recurring.
	const cafe = [0, 3, 43, 52, 112].map((d) => row("acc_a", new Date(Date.parse("2026-06-01T00:00:00Z") + d * 864e5).toISOString(), -5, merchant("Cafe")));
	// Monthly until June, then stopped.
	const old = ["2026-03", "2026-04", "2026-05", "2026-06"].map((m) => row("acc_a", nzMonthRange(m).start, -9, merchant("Old Sub")));
	const found = findRecurring([...netflix, ...gym, ...cafe, ...old, row("acc_a", "2026-10-02T00:00:00Z", 15)], { today: "2026-10-15", minOccurrences: 3 });
	expect(found.map((p) => p.payee)).toEqual(["Gym", "Netflix", "Old Sub"]);
	const [gymOut, netflixOut, oldOut] = found;
	expect(gymOut).toMatchObject({ cadence: "weekly", interval_days: 7, typical_amount: -10, amount_varies: true, monthly_equivalent: -43.49, status: "active", next_expected: "2026-10-13" });
	expect(netflixOut).toMatchObject({ cadence: "monthly", occurrences: 6, typical_amount: -22.99, monthly_equivalent: -22.99, first_date: "2026-05-01", last_date: "2026-10-01", status: "active", next_expected: "2026-11-01" });
	expect(netflixOut!.evidence_ids).toEqual(netflix.slice(-5).map((t) => t._id));
	expect(oldOut).toMatchObject({ cadence: "monthly", status: "lapsed" });
	expect(oldOut!.next_expected).toBeUndefined();
});

test("unusual debits are first payments to a payee or at least 3 times its usual amount, within the period", () => {
	const at = (day: number) => new Date(Date.parse("2026-09-01T00:00:00Z") + day * 864e5).toISOString();
	const power = (day: number, amount: number) => row("acc_a", at(day), amount, { merchant: { name: "Power Co" } });
	const rows = [
		power(0, -50), power(30, -50), power(60, -40),
		power(65, -150), // 3.33× the usual 50: flagged
		power(70, -140), // 2.8× the usual 50 (median of 50, 50, 40, 150): not flagged
		row("acc_a", at(66), -400, { description: "NEW DENTIST" }), // first payment
		row("acc_a", at(67), -99, { description: "NEW SHOP" }), // below min_amount
		row("acc_a", at(10), -900, { description: "OLD BIG" }), // before the period
		row("acc_a", at(68), 600, { description: "REFUND" }), // money in
	];
	const found = findUnusual(rows, { start: at(61), end: at(80), minAmount: 100 });
	expect(found.map((d) => [d.description, d.reason])).toEqual([["NEW DENTIST", "first_payment_to_payee"], ["Synthetic", "large_for_payee"]]);
	expect(found[1]).toMatchObject({ amount: -150, usual_amount: -50, times_usual: 3, earlier_payments: 3 });
});
