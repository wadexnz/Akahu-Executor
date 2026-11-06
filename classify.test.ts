import { describe, expect, test } from "bun:test";
import type { Row } from "./analysis.js";
import { classify, rulesApplied, type Rule } from "./classify.js";
import type { Account } from "./schemas.js";

// Cases ported from the mobile app's classifyTransaction tests, plus what this app adds:
// exclude rules, richer rule matches and per-currency pairing.
let n = 0;
const row = (account: string, amount: number, extra: Partial<Row> = {}): Row => ({
	_id: `trans_${++n}`, _account: account, date: "2026-06-01T00:00:00.000Z", description: "Synthetic", amount, type: "EFTPOS", currency: "NZD", ...extra,
});
const account = (_id: string, type = "CHECKING", extra: Partial<Account> = {}): Account =>
	({ _id, name: _id, status: "ACTIVE", type, attributes: ["TRANSACTIONS"], connection: { name: "Synthetic Bank" }, ...extra });
const accounts = [account("acc_checking"), account("acc_savings", "SAVINGS"), account("acc_ks", "KIWISAVER"), account("acc_inv", "INVESTMENT"), account("acc_td", "TERMDEPOSIT"), account("acc_loan", "LOAN"), account("acc_usd", "FOREIGN")];
const flowOf = (rows: Row[], rules: Rule[] = []) => classify(rows, accounts, rules).map((t) => t.flow);
const BROKERS = { _id: "nzfcc_b", name: "Financial asset brokers, exchanges, and managed funds" };
const BROAD = { _id: "nzfcc_f", name: "Financial services (not elsewhere classified)" };

describe("automatic flows", () => {
	test("account types: KiwiSaver, investment and term deposit are saving; loans are transfers", () => {
		expect(flowOf([row("acc_ks", -100), row("acc_inv", 50), row("acc_td", -200), row("acc_loan", -500)])).toEqual(["saving", "saving", "saving", "transfer"]);
	});

	test("a same-NZ-day opposite pair across two accounts is a transfer, with each side pointing at the other", () => {
		const out = row("acc_checking", -200), into = row("acc_savings", 200);
		const result = classify([out, into], accounts, []);
		expect(result.map((t) => [t.flow, t.review])).toEqual([
			["transfer", { reason: "transfer", related_id: into._id }],
			["transfer", { reason: "transfer", related_id: out._id }],
		]);
	});

	test("pairs need the same NZ day, different accounts, the same currency and amounts within half a cent", () => {
		// 23:30 UTC on 1 June is 2 June in NZ (+12): a different NZ day from the debit.
		const nextDay = row("acc_savings", 300, { date: "2026-06-01T12:30:00.000Z" });
		const sameAccount = row("acc_checking", 400);
		const otherCurrency = row("acc_usd", 500, { currency: "USD" });
		const centOff = row("acc_savings", 600.01);
		const result = flowOf([row("acc_checking", -300), nextDay, row("acc_checking", -400), sameAccount, row("acc_checking", -500), otherCurrency, row("acc_checking", -600), centOff]);
		expect(result).toEqual(["spending", "income", "spending", "income", "spending", "income", "spending", "income"]);
		// Each credit pairs once: the second debit of the same amount stays spending.
		expect(flowOf([row("acc_checking", -50), row("acc_checking", -50), row("acc_savings", 50)])).toEqual(["transfer", "spending", "transfer"]);
	});

	test("Akahu types: fees and tax are spending, interest by sign, LOAN on a transaction account a transfer", () => {
		expect(flowOf([row("acc_checking", -2.5, { type: "FEE" }), row("acc_checking", -15, { type: "TAX" }), row("acc_checking", 1.23, { type: "INTEREST" }), row("acc_checking", -4.56, { type: "INTEREST" }), row("acc_checking", -300, { type: "LOAN" })]))
			.toEqual(["spending", "spending", "income", "spending", "transfer"]);
	});

	test("financial-services debits are saving, only the broad category asks for review, and credits are not matched", () => {
		const result = classify([row("acc_checking", -150, { category: BROKERS }), row("acc_checking", -24, { category: BROAD }), row("acc_checking", 150, { category: BROKERS })], accounts, []);
		expect(result.map((t) => [t.flow, t.review?.reason])).toEqual([["saving", undefined], ["saving", "category"], ["income", undefined]]);
	});

	test("merchant-less credits naming exactly one saving provider are saving withdrawals, linked to the payment", () => {
		const acornOut = row("acc_checking", -321.45, { merchant: { _id: "merchant_acorn", name: "Acorn Investments" }, category: BROKERS });
		const stashOut = row("acc_checking", -234.56, { merchant: { _id: "merchant_stash", name: "Stash Investments" }, category: BROAD });
		const acornBack = row("acc_checking", 123.45, { description: "ACORN example withdrawal" });
		const stashBack = row("acc_checking", 91.25, { description: "Stash" });
		// "investments" is shared by both providers, so it identifies neither.
		const ambiguous = row("acc_checking", 50, { description: "Investments payout" });
		const both = row("acc_checking", 60, { description: "Acorn to Stash" });
		const enriched = row("acc_checking", 70, { description: "Acorn", merchant: { _id: "merchant_other", name: "Other" } });
		const result = classify([acornOut, stashOut, acornBack, stashBack, ambiguous, both, enriched], accounts, []);
		expect(result.map((t) => t.flow)).toEqual(["saving", "saving", "saving", "saving", "income", "income", "income"]);
		expect(result[2]!.review).toEqual({ reason: "provider", related_id: acornOut._id });
	});

	test("otherwise debits are spending and credits income", () => {
		expect(flowOf([row("acc_checking", -42), row("acc_checking", 100, { type: "CREDIT" })])).toEqual(["spending", "income"]);
	});
});

describe("rules", () => {
	test("the first matching rule wins over every automatic step, including account type and pairing", () => {
		const rules: Rule[] = [
			{ id: "rule_ks", kind: "transfer", match: { account_id: "acc_ks" } },
			{ id: "rule_first", kind: "income", match: { description: "streamco" } },
			{ id: "rule_second", kind: "spending", match: { description: "STREAMCO" } },
			{ id: "rule_pair", kind: "exclude", match: { description: "house deposit" } },
		];
		const out = row("acc_checking", -900, { description: "House deposit" }), into = row("acc_savings", 900);
		const result = classify([row("acc_ks", -100), row("acc_checking", -15, { description: "StreamCo subscription" }), out, into], accounts, rules);
		// As in the mobile app, pairing runs before rules: the credit whose debit a rule claimed
		// still counts as a transfer.
		expect(result.map((t) => t.flow)).toEqual(["transfer", "income", "excluded", "transfer"]);
		expect(rulesApplied(result)).toEqual([{ count: 1, rule_id: "rule_first" }, { count: 1, rule_id: "rule_ks" }, { count: 1, rule_id: "rule_pair" }]);
	});

	test("an account rule follows a classic account id through official open banking migration", () => {
		const official = account("acc_official", "CHECKING", { _migrated: "acc_classic" });
		const result = classify([row("acc_official", 250)], [official], [{ id: "rule_m", kind: "saving", match: { account_id: "acc_classic" } }]);
		expect(result[0]!.flow).toBe("saving");
	});

	test("every criterion of a rule must match, and a non-matching rule falls through", () => {
		const rules: Rule[] = [{ id: "rule_card", kind: "transfer", match: { description: "card", merchant: "bank", other_account: "12-3456", direction: "debit" } }];
		const hit = row("acc_checking", -80, { description: "CARD PAYMENT", merchant: { name: "Big Bank" }, meta: { other_account: "12 3456 0001234 00" } });
		const credit = { ...hit, _id: "trans_credit", amount: 80 };
		const otherAccount = { ...hit, _id: "trans_other", meta: { other_account: "99-0000" } };
		expect(flowOf([hit, credit, otherAccount], rules)).toEqual(["transfer", "income", "spending"]);
	});
});
