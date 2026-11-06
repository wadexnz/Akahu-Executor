import { array, boolean, json, number, object, record, string, type Infer } from "apps";

// Decode only fields the tools consume; Akahu may add other response fields.
const TransactionFields = {
	_account: string(),
	date: string(),
	description: string(),
	amount: number(),
	type: string(),
	balance: number().optional(),
	merchant: object({ _id: string().optional(), name: string(), website: string().optional() }).optional(),
	category: object({ name: string(), groups: record(object({ name: string() })).optional() }).optional(),
	meta: object({
		particulars: string().optional(),
		code: string().optional(),
		reference: string().optional(),
		other_account: string().optional(),
		card_suffix: string().optional(),
		conversion: object({ amount: number(), currency: string(), rate: number() }).optional(),
	}).optional(),
};
// _migrated: the classic transaction an official-open-banking one replaced (a new id).
export const Transaction = object({ _id: string(), _migrated: string().optional(), ...TransactionFields });
export type Transaction = Infer<typeof Transaction>;
export const PendingTransaction = object({ ...TransactionFields, updated_at: string().optional() });
export type PendingTransaction = Infer<typeof PendingTransaction>;
export const Account = object({
	_id: string(),
	// The classic account an official-open-banking account replaced.
	_migrated: string().optional(),
	name: string(),
	status: string(),
	type: string(),
	attributes: array(string()),
	formatted_account: string().optional(),
	refreshed: record(string()).optional(),
	connection: object({ name: string(), connection_type: string().optional() }),
	balance: object({
		currency: string(), current: number(), available: number().optional(), limit: number().optional(), overdrawn: boolean().optional(),
	}).optional(),
});
export type Account = Infer<typeof Account>;
const Value = object({ value: string() });
export const Party = object({
	_id: string(),
	_connection: string(),
	name: Value.optional(),
	dob: Value.optional(),
	tax_number: Value.optional(),
	phone_numbers: array(object({ value: string(), subtype: string().optional(), verified: boolean().optional() })).optional(),
	email_addresses: array(object({ value: string(), subtype: string().optional(), verified: boolean().optional() })).optional(),
	addresses: array(object({ value: string(), subtype: string().optional(), formatted: string().optional() })).optional(),
});
export type Party = Infer<typeof Party>;
const NameFlags = object({ given_name: boolean(), middle_name: boolean(), family_name: boolean(), middle_initial: boolean(), given_initial: boolean() });
export const NameVerification = object({
	sources: array(object({
		type: string(),
		match_result: string(),
		verification: NameFlags,
		meta: object({ _id: string().optional(), formatted_account: string().optional(), sources: array(string()).optional() }),
	})),
});
export const User = object({
	_id: string(), email: string().optional(), preferred_name: string().optional(), access_granted_at: string().optional(),
});


// Agent-facing shapes.
export const Empty = object({});
export const Interval = object({ start: string(), end: string() });
export const CompareInput = object({ account_ids: array(string()), baseline: Interval, comparison: Interval });
const TxnFields = {
	id: string().optional(),
	pending: boolean().optional(),
	account_id: string(),
	date: string(),
	description: string(),
	amount: number(),
	type: string(),
	balance: number().optional(),
	merchant: string().optional(),
	category: string().optional(),
	category_group: string().optional(),
	particulars: string().optional(),
	code: string().optional(),
	reference: string().optional(),
	other_account: string().optional(),
	card_suffix: string().optional(),
	fx: object({ amount: number(), currency: string(), rate: number() }).optional(),
	flow: string().optional(),
	note: string().optional(),
	tags: array(string()).optional(),
};
export const Txn = object(TxnFields);
// A settled row with the currency of its account (review cases).
export const CaseTxn = object({ ...TxnFields, currency: string() });
export const AccountOut = object({
	id: string(),
	bank: string(),
	name: string(),
	number: string().optional(),
	type: string(),
	status: string(),
	has_transactions: boolean(),
	balance: object({ currency: string(), current: number(), available: number(), limit: number().optional(), overdrawn: boolean().optional() }).optional(),
	connection_type: string().optional(),
	refreshed: record(string()).optional(),
});
export const Delta = object({
	name: string(),
	baseline_debits: number(),
	comparison_debits: number(),
	delta: number(),
	percent_change: json(),
	baseline_count: number(),
	comparison_count: number(),
	baseline_ids: array(string()),
	comparison_ids: array(string()),
});
export const Totals = object({ settled_count: number(), debit_count: number(), debits: number() });
export const CompareOut = object({
	currency: string(),
	scope: object({
		requested_account_ids: array(string()),
		included_account_ids: array(string()),
		excluded_accounts: array(object({ account_id: string(), reason: string() })),
		baseline: Interval,
		comparison: Interval,
	}),
	account_metadata: array(object({ account_id: string(), status: string(), refreshed: json() })),
	coverage: string(),
	elapsed_seconds: object({ baseline: number(), comparison: number(), mismatch: boolean() }),
	limitations: array(string()),
	baseline: Totals,
	comparison: Totals,
	category_deltas: array(Delta),
	merchant_deltas: array(Delta),
	heuristic: object({ rule: string(), baseline_median: json(), threshold: json(), baseline_evidence_ids: array(string()), status: string() }),
	unusual_debits: array(object({ id: string(), account_id: string(), date: string(), description: string(), debit: number(), type: string(), reason: string() })),
});

// Shapes the dashboard (ui/) reads as well as agents. Keep this module free of server code.
export const RulesApplied = array(object({ rule_id: string(), count: number() }));
export const Currencies = array(string());
export const RecurringOut = object({
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
});
export const CashflowOut = object({
	period: Interval,
	currencies: array(object({
		currency: string(),
		months: array(object({
			month: string(), partial: boolean(), income: number(), spending: number(), net: number(), saving: number(),
			transfers_left_out: number(), excluded_by_rules: number(), top_spending: array(object({ category: string(), amount: number() })),
		})),
		total: object({ income: number(), spending: number(), net: number(), saving: number() }),
	})),
	rules_applied: RulesApplied,
	unknown_currency_transaction_ids: Currencies,
});
export const BudgetStatusOut = object({
	month: string(), period: Interval, month_elapsed_percent: number(),
	budgets: array(object({ group: string(), currency: string(), budget: number(), spent: number(), remaining: number(), percent_used: number() })),
	unbudgeted: array(object({ group: string(), currency: string(), spent: number() })),
	rules_applied: RulesApplied,
	unknown_currency_transaction_ids: Currencies,
});
export const Budget = object({ group: string(), currency: string(), monthly_amount: number() });
export const Alert = object({
	id: string(), kind: string(), message: string(), created_at: string(), acknowledged: boolean(),
	account_id: string().optional(), transaction_id: string().optional(),
});
export const BalanceHistoryOut = object({
	from: string(), to: string(),
	accounts: array(object({ account_id: string(), currency: string(), snapshots: array(object({ day: string(), current: number(), available: number() })) })),
	totals: array(object({ currency: string(), days: array(object({ day: string(), current: number(), accounts_counted: number() })) })),
});
