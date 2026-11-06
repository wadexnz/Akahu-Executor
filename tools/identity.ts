import { array, boolean, object, query, router, string } from "apps";
import { always } from "apps/operations/approval";
import { getItem, getItems, postRead } from "../client.js";
import { Empty, NameVerification, Party, User } from "../schemas.js";
import { client, READ, type Ctx } from "./context.js";

const getMe = query(
	{
		title: "Get Akahu user",
		description: "The Akahu user behind the connected account.",
		input: Empty,
		output: object({ id: string(), email: string().optional(), preferred_name: string().optional(), access_granted_at: string().optional() }),
		annotations: READ,
	},
	async (ctx: Ctx) => {
		const me = await getItem(client(ctx), "/me", User);
		return {
			id: me._id,
			...(me.email && { email: me.email }),
			...(me.preferred_name && { preferred_name: me.preferred_name }),
			...(me.access_granted_at && { access_granted_at: me.access_granted_at }),
		};
	},
);

// Identity data a bank holds about the user. Only the fields the caller names are
// returned; the rest are reported as withheld so the agent can ask for them.
const PARTY_FIELDS = ["name", "dob", "tax_number", "email_addresses", "phone_numbers", "addresses"] as const;
type PartyField = typeof PARTY_FIELDS[number];
const Contact = object({ value: string(), subtype: string().optional(), verified: boolean().optional() });

function present(p: Party, field: PartyField) {
	const value = p[field];
	return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

function partyOut(p: Party, wanted: ReadonlySet<PartyField>) {
	const show = (field: PartyField) => wanted.has(field) && present(p, field);
	return {
		id: p._id,
		connection_id: p._connection,
		...(show("name") && { name: p.name!.value }),
		...(show("dob") && { dob: p.dob!.value }),
		...(show("tax_number") && { tax_number: p.tax_number!.value }),
		...(show("email_addresses") && { email_addresses: p.email_addresses! }),
		...(show("phone_numbers") && { phone_numbers: p.phone_numbers! }),
		...(show("addresses") && { addresses: p.addresses!.map((a) => ({ value: a.formatted ?? a.value, ...(a.subtype && { subtype: a.subtype }) })) }),
	};
}

const getParties = query(
	{
		title: "Get identity data held by the banks",
		description: `Identity details each connected bank holds about the user (Akahu /parties), refreshed by Akahu about every 30 days. Returns only the requested fields (default name only); choose from ${PARTY_FIELDS.join(", ")}. tax_number is the user's IRD number and dob their date of birth: request them only when the user's task needs them. withheld_fields lists other fields that exist but were not requested. Needs the user's approval on every call.`,
		input: object({ fields: array(string()).default(["name"]) }),
		output: object({
			parties: array(object({
				id: string(), connection_id: string(), name: string().optional(), dob: string().optional(), tax_number: string().optional(),
				email_addresses: array(Contact).optional(), phone_numbers: array(Contact).optional(),
				addresses: array(object({ value: string(), subtype: string().optional() })).optional(),
			})),
			withheld_fields: array(string()),
		}),
		annotations: READ,
		approval: always(),
	},
	async (ctx: Ctx, { fields }) => {
		const unknown = fields.filter((f) => !(PARTY_FIELDS as readonly string[]).includes(f));
		if (unknown.length) throw new Error(`Unknown fields ${unknown.join(", ")}; choose from ${PARTY_FIELDS.join(", ")}`);
		const wanted = new Set(fields as PartyField[]);
		const parties = await getItems(client(ctx), "/parties", Party);
		return {
			parties: parties.map((p) => partyOut(p, wanted)),
			withheld_fields: PARTY_FIELDS.filter((f) => !wanted.has(f) && parties.some((p) => present(p, f))),
		};
	},
);

const Flags = object({ given_name: boolean(), middle_name: boolean(), family_name: boolean(), middle_initial: boolean(), given_initial: boolean() });

const verifyName = query(
	{
		title: "Verify a name against bank records",
		description: "Check a name against the account holder names and identity data the user's banks hold (Akahu /verify/name). family_name is required; given_name, middle_name and initials are optional. Each match reports its source (PARTY_NAME or HOLDER_NAME), MATCH or PARTIAL_MATCH, which name parts matched, and the account or connections it came from. Matched names are not repeated back. No matches means no source matched, not that the name is false. Needs the user's approval on every call.",
		input: object({
			family_name: string({ minLength: 1 }),
			given_name: string({ minLength: 1 }).optional(),
			middle_name: string({ minLength: 1 }).optional(),
			initials: array(string({ minLength: 1 })).optional(),
		}),
		output: object({
			matches: array(object({
				source: string(), match_result: string(), verification: Flags,
				account_id: string().optional(), account_number: string().optional(), connection_ids: array(string()).optional(),
			})),
		}),
		annotations: READ,
		approval: always(),
	},
	async (ctx: Ctx, name) => {
		const { item } = await postRead(client(ctx), "/verify/name", name, object({ item: NameVerification }));
		return {
			matches: item.sources.map((s) => ({
				source: s.type, match_result: s.match_result, verification: s.verification,
				...(s.meta._id && { account_id: s.meta._id }),
				...(s.meta.formatted_account && { account_number: s.meta.formatted_account }),
				...(s.meta.sources && { connection_ids: s.meta.sources }),
			})),
		};
	},
);

export const identity = router({ me: getMe, parties: getParties, verifyName }, {
	title: "Identity",
	description: "The Akahu user, and the identity data their banks hold.",
	instructions: "identity.parties and identity.verifyName read personal identity data and need the user's approval on every call. Request only the party fields the task needs: tax_number is the user's IRD number and dob their date of birth. Do not repeat identity details back unless the user asked for them, and never store them elsewhere.",
});
