import { array, boolean, json, number, object, record, string, type Infer } from "apps";

// Decode only fields the tools consume; Akahu may add other response fields.
const TransactionFields = {
	_account: string(),
	date: string(),
	description: string(),
	amount: number(),
	type: string(),
	balance: number().optional(),
	merchant: object({ name: string(), website: string().optional() }).optional(),
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
export const Transaction = object({ _id: string(), ...TransactionFields });
export type Transaction = Infer<typeof Transaction>;
export const PendingTransaction = object({ ...TransactionFields, updated_at: string().optional() });
export type PendingTransaction = Infer<typeof PendingTransaction>;
export const Account = object({
	_id: string(),
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
export const Txn = object({
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
	note: string().optional(),
	tags: array(string()).optional(),
});
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
