import { useEffect, useMemo, useState, type ReactNode } from "react";
import { array, type Infer } from "apps";
import { mutationReference, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { listAccounts } from "../tools/accounts.js";
import type { addRule, setNote, tag, untag } from "../tools/memory.js";
import type { decide, previewRule } from "../tools/review.js";
import type { exportCsv, getTransactions } from "../tools/transactions.js";
import { AccountOut, CsvOut, DecideOut, NoteOut, PreviewRuleOut, ReviewCasesOut, RuleOut, SearchOut, TagOut, Txn, UntagOut } from "../schemas.js";
import { reviewAtom } from "./home.js";
import { client, errorText, FLOW_LABELS, FlowIcon, FlowPill, Icon, Loaded, money, nzDay, nzMidnight, nzToday, signed, weekdayLabel } from "./shared.js";
import { transactionIconName } from "./transaction-icon.js";

export const accountsAtom = client.queryAtom(queryReference<typeof listAccounts>("accounts.list"), {}, array(AccountOut));
const searchRef = queryReference<typeof getTransactions>("transactions.search");
const exportRef = queryReference<typeof exportCsv>("transactions.exportCsv");
const previewRef = queryReference<typeof previewRule>("review.previewRule");
const decideRef = mutationReference<typeof decide>("review.decide");
const noteRef = mutationReference<typeof setNote>("memory.setNote");
const tagRef = mutationReference<typeof tag>("memory.tag");
const untagRef = mutationReference<typeof untag>("memory.untag");
const addRuleRef = mutationReference<typeof addRule>("memory.addRule");

type Row = Infer<typeof Txn>;
type Account = Infer<typeof AccountOut>;
type Case = Infer<typeof ReviewCasesOut>["cases"][number];
type Previous = Infer<typeof DecideOut>["previous"];
const FLOWS = ["spending", "income", "transfer", "saving"] as const;

const PERIODS = [
	{ id: "30d", label: "Last 30 days", days: 30 },
	{ id: "90d", label: "Last 90 days", days: 90 },
	{ id: "month", label: "This month" },
	{ id: "12m", label: "Last 12 months", days: 365 },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

function range(period: PeriodId) {
	const end = new Date().toISOString();
	if (period === "month") {
		// Akahu's start is exclusive, so start a millisecond before NZ midnight on the 1st.
		return { start: new Date(nzMidnight(`${nzToday().slice(0, 7)}-01`) - 1).toISOString(), end };
	}
	const days = PERIODS.find((p) => p.id === period)!;
	return { start: new Date(Date.now() - ("days" in days ? days.days : 30) * 864e5).toISOString(), end };
}

export const accountLabel = (a: Pick<Account, "name" | "number"> | undefined, id: string) =>
	a ? `${a.name}${a.number ? ` ··${a.number.replace(/\D/g, "").slice(-4)}` : ""}` : id;

function Chip({ children, onClear }: { children: ReactNode; onClear?: () => void }) {
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full bg-soft px-3 py-1.5 text-sm text-primary">
			{children}
			{onClear && <button aria-label="Clear filter" onClick={onClear}><Icon name="X" size={14} /></button>}
		</span>
	);
}

function TransactionRow({ t, account, selected, onSelect }: { t: Row; account?: Account; selected: boolean; onSelect: () => void }) {
	const flow = t.flow ?? (t.amount < 0 ? "spending" : "income");
	const sub = [t.category, t.merchant].filter(Boolean).join(" · ");
	return (
		<li>
			<button onClick={onSelect} aria-pressed={selected}
				className={`grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2 py-2.5 text-left sm:grid-cols-[auto_1fr_150px_auto_84px] ${selected ? "bg-soft" : "hover:bg-soft/60"}`}>
				<FlowIcon name={transactionIconName({ ...t, flow })} flow={flow} />
				<span className="min-w-0">
					<span className="block truncate">{t.description}</span>
					<span className="block truncate text-sm text-muted">{sub || "Uncategorised"}{t.note ? " · 📝" : ""}</span>
				</span>
				<span className="truncate text-sm text-muted max-sm:hidden">{accountLabel(account, t.account_id)}</span>
				<span className={`text-right font-medium ${t.amount > 0 ? "text-income" : ""}`}>{signed(t.amount, account?.balance?.currency ?? "NZD")}</span>
				<span className="text-right max-sm:hidden"><FlowPill flow={flow} /></span>
			</button>
		</li>
	);
}

function DayGroups({ rows, accounts, selected, onSelect }: { rows: Row[]; accounts: Map<string, Account>; selected?: string; onSelect: (t: Row) => void }) {
	const today = nzToday();
	const days = new Map<string, Row[]>();
	for (const t of rows) days.set(nzDay(t.date), [...(days.get(nzDay(t.date)) ?? []), t]);
	return (
		<div className="flex flex-col gap-4">
			{[...days].map(([day, list]) => (
				<section key={day}>
					<h3 className="border-b border-line px-2 pb-1.5 text-sm font-medium text-muted">{day === today ? `Today · ${weekdayLabel(day)}` : weekdayLabel(day)}</h3>
					<ul className="mt-1">
						{list.map((t) => <TransactionRow key={t.id} t={t} account={accounts.get(t.account_id)} selected={t.id === selected} onSelect={() => onSelect(t)} />)}
					</ul>
				</section>
			))}
		</div>
	);
}

function Undo({ previous, onDone }: { previous: Previous; onDone: () => void }) {
	const [busy, setBusy] = useState(false);
	return (
		<div className="flex items-center gap-3 rounded-lg bg-ink px-4 py-2.5 text-sm text-bg" role="status">
			<span className="flex-1">Decision saved</span>
			<button disabled={busy} className="flex items-center gap-1 font-medium" onClick={async () => {
				setBusy(true);
				try { await client.mutate(decideRef, { decisions: previous }, DecideOut); } finally { onDone(); }
			}}><Icon name="Undo2" size={16} />Undo</button>
		</div>
	);
}

function RulePreview({ t, flow, onClose }: { t: Row; flow: string; onClose: () => void }) {
	const [pattern, setPattern] = useState(t.description);
	const [kind, setKind] = useState(flow);
	const [preview, setPreview] = useState<Infer<typeof PreviewRuleOut>>();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string>();
	const input = { kind, match: { description: pattern.trim() } };
	const run = async () => {
		setBusy(true); setMessage(undefined);
		try { setPreview(await client.query(previewRef, input, PreviewRuleOut)); } catch (e) { setMessage(errorText(e, "Couldn't preview the rule.")); } finally { setBusy(false); }
	};
	const save = async () => {
		setBusy(true); setMessage(undefined);
		try { await client.mutate(addRuleRef, input, RuleOut); setMessage("Rule saved. Find it under More."); setPreview(undefined); } catch (e) { setMessage(errorText(e, "Couldn't save the rule.")); } finally { setBusy(false); }
	};
	return (
		<div className="flex flex-col gap-3 rounded-lg border border-line p-3">
			<div className="flex items-center justify-between"><b>Rule for similar transactions</b><button aria-label="Close rule" onClick={onClose}><Icon name="X" size={16} /></button></div>
			<label className="text-sm text-muted">Description contains
				<input className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-ink" value={pattern} onChange={(e) => { setPattern(e.target.value); setPreview(undefined); }} />
			</label>
			<label className="text-sm text-muted">Set flow to
				<select className="mt-1 w-full rounded-md border border-line bg-bg px-3 py-2 text-ink" value={kind} onChange={(e) => { setKind(e.target.value); setPreview(undefined); }}>
					{FLOWS.map((f) => <option key={f} value={f}>{FLOW_LABELS[f]}</option>)}
					<option value="exclude">Leave out of insights</option>
				</select>
			</label>
			{preview && (
				<div className="rounded-md bg-soft p-3 text-sm">
					<b>{preview.matches} match{preview.matches === 1 ? "" : "es"} · {preview.would_change} would change</b>
					{preview.changes.map((c) => <div key={`${c.from}>${c.to}`} className="text-muted">{c.count} from {FLOW_LABELS[c.from] ?? c.from} to {FLOW_LABELS[c.to] ?? c.to}</div>)}
					{(preview.kept_by_decision > 0 || preview.kept_by_earlier_rule > 0) && <div className="text-muted">{preview.kept_by_decision} kept by your decisions, {preview.kept_by_earlier_rule} by earlier rules</div>}
					<ul className="mt-2 flex flex-col gap-1">
						{preview.examples.slice(0, 5).map((e) => <li key={e.id} className="flex justify-between gap-2"><span className="truncate">{e.date} · {e.description}</span><span>{signed(e.amount, e.currency)}</span></li>)}
					</ul>
				</div>
			)}
			{message && <p className="text-sm text-muted" role="status">{message}</p>}
			<div className="flex gap-2">
				<button disabled={busy || !pattern.trim()} onClick={run} className="rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-50">Preview</button>
				<button disabled={busy || !preview} onClick={save} className="rounded-md bg-primary px-3 py-1.5 text-sm text-on-primary disabled:opacity-50">Save rule</button>
			</div>
			<p className="text-xs text-muted">Your own decisions on single transactions still win over rules.</p>
		</div>
	);
}

function Detail({ t, accounts, onClose }: { t: Row; accounts: Map<string, Account>; onClose: () => void }) {
	const review = useAppQuery(reviewAtom);
	const [undo, setUndo] = useState<Previous>();
	const [rule, setRule] = useState(false);
	const [note, setNoteText] = useState(t.note ?? "");
	const [newTag, setNewTag] = useState("");
	const [failure, setFailure] = useState<string>();
	const [busy, setBusy] = useState(false);
	useEffect(() => { setNoteText(t.note ?? ""); setRule(false); setUndo(undefined); setFailure(undefined); }, [t.id, t.note]);
	const account = accounts.get(t.account_id), currency = account?.balance?.currency ?? "NZD";
	const flow = t.flow ?? (t.amount < 0 ? "spending" : "income");
	const found: Case | undefined = review.data?.cases.find((k) => k.transactions.some((x) => x.id === t.id));
	const other = found?.transactions.find((x) => x.id !== t.id) ?? found?.evidence;
	const act = async (work: () => Promise<unknown>, fallback: string) => {
		setBusy(true); setFailure(undefined);
		try { await work(); } catch (e) { setFailure(errorText(e, fallback)); } finally { setBusy(false); }
	};
	const choose = (choice: string) => act(async () => {
		// Both sides of a pair are decided together, each pointing at the other.
		const ids = found && found.transactions.length === 2 ? found.transactions.map((x) => x.id!) : [t.id!];
		const result = await client.mutate(decideRef, { decisions: ids.map((id) => ({ transaction_id: id, flow: choice, ...(ids.length === 2 && choice !== "automatic" && { paired_id: ids.find((x) => x !== id) }) })) }, DecideOut);
		setUndo(result.previous);
	}, "Couldn't save that decision.");
	return (
		<aside className="flex flex-col gap-5 overflow-y-auto p-5 max-lg:fixed max-lg:inset-0 max-lg:z-30 max-lg:bg-bg lg:sticky lg:top-16 lg:max-h-[calc(100dvh-4rem)] lg:border-l lg:border-line" aria-label="Transaction detail">
			<div className="flex items-start gap-3">
				<FlowIcon name={transactionIconName({ ...t, flow })} flow={flow} size={48} />
				<div className="min-w-0 flex-1">
					<h2 className="text-lg font-semibold break-words">{t.description}</h2>
					<div className={`text-2xl font-bold ${t.amount > 0 ? "text-income" : ""}`}>{signed(t.amount, currency)}</div>
					<div className="text-sm text-muted">{weekdayLabel(nzDay(t.date))}</div>
				</div>
				<button aria-label="Close detail" onClick={onClose} className="p-1"><Icon name="X" /></button>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-y border-line py-3 text-sm">
				<dt className="text-muted">Account</dt><dd className="text-right">{accountLabel(account, t.account_id)}</dd>
				{t.merchant && <><dt className="text-muted">Merchant</dt><dd className="text-right">{t.merchant}</dd></>}
				<dt className="text-muted">Category</dt><dd className="text-right">{t.category ?? "Uncategorised"}</dd>
				{t.reference && <><dt className="text-muted">Reference</dt><dd className="text-right break-all">{t.reference}</dd></>}
				{t.fx && <><dt className="text-muted">Original</dt><dd className="text-right">{money(t.fx.amount, t.fx.currency)}</dd></>}
			</dl>
			<section>
				<h3 className="mb-2 font-medium">Flow</h3>
				<div className="grid grid-cols-4 gap-2">
					{FLOWS.map((f) => (
						<button key={f} disabled={busy} onClick={() => choose(f)} aria-pressed={flow === f}
							className={`flex flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs ${flow === f ? "border-primary bg-soft text-primary" : "border-line"}`}>
							<Icon name={f === "spending" ? "ShoppingBag" : f === "income" ? "ArrowDownLeft" : f === "transfer" ? "ArrowLeftRight" : "Sprout"} size={18} />
							{FLOW_LABELS[f]}
						</button>
					))}
				</div>
				<button disabled={busy} onClick={() => choose("automatic")} className="mt-2 rounded-full border border-line px-3 py-1 text-sm">Automatic</button>
				{found && <p className="mt-2 flex items-center gap-1.5 text-sm text-muted"><Icon name="Info" size={16} />{found.explanation}</p>}
				{undo && <div className="mt-3"><Undo previous={undo} onDone={() => setUndo(undefined)} /></div>}
			</section>
			{other && (
				<section>
					<h3 className="mb-2 font-medium">{found?.transactions.length === 2 ? "Paired transaction" : "Matched with"}</h3>
					<div className="flex items-center gap-3 rounded-lg border border-line p-3">
						<FlowIcon name="ArrowUpRight" flow={other.flow ?? (other.amount < 0 ? "spending" : "income")} />
						<div className="min-w-0 flex-1">
							<div className="truncate">{other.description}</div>
							<div className="text-sm text-muted"><span className={other.amount > 0 ? "text-income" : ""}>{signed(other.amount, other.currency)}</span> · {accountLabel(accounts.get(other.account_id), other.account_id)}</div>
						</div>
					</div>
				</section>
			)}
			<section>
				<h3 className="mb-2 font-medium">Note</h3>
				<input className="w-full rounded-md border border-line bg-bg px-3 py-2" placeholder="Add a note…" value={note} maxLength={1000}
					onChange={(e) => setNoteText(e.target.value)}
					onBlur={() => note.trim() !== (t.note ?? "") && act(() => client.mutate(noteRef, { transaction_id: t.id!, note }, NoteOut), "Couldn't save the note.")} />
			</section>
			<section>
				<h3 className="mb-2 font-medium">Tags</h3>
				<div className="flex flex-wrap gap-2">
					{(t.tags ?? []).map((x) => <Chip key={x} onClear={() => act(() => client.mutate(untagRef, { transaction_ids: [t.id!], tag: x }, UntagOut), "Couldn't remove the tag.")}>{x}</Chip>)}
					<form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (newTag.trim()) act(async () => { await client.mutate(tagRef, { transaction_ids: [t.id!], tag: newTag }, TagOut); setNewTag(""); }, "Couldn't add the tag."); }}>
						<input className="w-28 rounded-full border border-line bg-bg px-3 py-1 text-sm" placeholder="Add tag" aria-label="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
						<button aria-label="Add tag" className="text-primary"><Icon name="Plus" size={18} /></button>
					</form>
				</div>
			</section>
			{failure && <p className="text-sm text-danger" role="alert">{failure}</p>}
			{rule ? <RulePreview t={t} flow={flow} onClose={() => setRule(false)} /> : (
				<button onClick={() => setRule(true)} className="flex items-center gap-2 font-medium text-primary"><Icon name="ListPlus" size={18} />Make a rule for similar transactions</button>
			)}
		</aside>
	);
}

function ReviewList({ accounts, selected, onSelect }: { accounts: Map<string, Account>; selected?: string; onSelect: (t: Row) => void }) {
	const review = useAppQuery(reviewAtom);
	return (
		<Loaded result={review} height="h-40">
			{(data) => data.cases.length === 0 ? <p className="px-2 py-6 text-muted">Nothing to review. Every flow in the last 90 days is either certain or your own decision.</p> : (
				<ul className="flex flex-col gap-3">
					{data.cases.map((k) => (
						<li key={k.id} className="rounded-lg border border-line p-2">
							<p className="flex items-center gap-1.5 px-2 pt-1 text-sm text-warning"><Icon name="Info" size={16} />{k.explanation}</p>
							<ul>
								{k.transactions.map((t) => <TransactionRow key={t.id} t={t} account={accounts.get(t.account_id)} selected={t.id === selected} onSelect={() => onSelect(t)} />)}
							</ul>
							{k.evidence && <p className="px-2 pb-1 text-sm text-muted">Matched with {k.evidence.description} ({signed(k.evidence.amount, k.evidence.currency)})</p>}
						</li>
					))}
				</ul>
			)}
		</Loaded>
	);
}

async function download(filters: object) {
	const file = await client.query(exportRef, { ...filters, limit: 10000 }, CsvOut);
	const url = URL.createObjectURL(new Blob([file.csv], { type: "text/csv" }));
	const a = Object.assign(document.createElement("a"), { href: url, download: file.filename });
	a.click();
	URL.revokeObjectURL(url);
	return file;
}

export function Transactions({ view, go }: { view: "all" | "review"; go: (path: string) => void }) {
	const accounts = useAppQuery(accountsAtom);
	const byId = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
	const review = useAppQuery(reviewAtom);
	const [period, setPeriod] = useState<PeriodId>("30d");
	const [flow, setFlow] = useState<string>();
	const [accountId, setAccountId] = useState<string>();
	const [text, setText] = useState("");
	const [filtering, setFiltering] = useState(false);
	const [selectedId, setSelectedId] = useState<string>();
	const [exportState, setExportState] = useState<string>();
	const filters = useMemo(() => ({ ...range(period), ...(flow && { flow }), ...(accountId && { account_id: accountId }) }), [period, flow, accountId]);
	const searchAtom = useMemo(() => client.queryAtom(searchRef, { ...filters, limit: 1000 }, SearchOut), [filters]);
	const search = useAppQuery(searchAtom);
	const needle = text.trim().toLowerCase();
	const rows = (search.data?.transactions ?? []).filter((t) => !needle || [t.description, t.merchant, t.category].some((v) => v?.toLowerCase().includes(needle)));
	const all = [...(search.data?.transactions ?? []), ...(review.data?.cases.flatMap((k) => k.transactions) ?? [])];
	const selected = all.find((t) => t.id === selectedId);
	const reviewCount = review.data?.cases.length;
	const seg = (on: boolean) => `rounded-md px-3 py-1.5 text-sm ${on ? "bg-bg font-medium shadow-[0_0_0_1px_var(--line)]" : "text-muted"}`;
	return (
		<div className={`grid gap-0 ${selected ? "lg:grid-cols-[1fr_400px]" : ""}`}>
			<div className="flex min-w-0 flex-col gap-4 pb-8 lg:pr-5">
				<h1 className="text-3xl font-bold tracking-tight">Transactions</h1>
				<div className="flex flex-wrap items-center gap-3">
					<div className="flex rounded-lg bg-soft p-1" role="group" aria-label="View">
						<button className={seg(view === "all")} aria-pressed={view === "all"} onClick={() => go("transactions")}>All</button>
						<button className={seg(view === "review")} aria-pressed={view === "review"} onClick={() => go("transactions?view=review")}>Review{reviewCount ? ` (${reviewCount})` : ""}</button>
					</div>
					{view === "all" && (
						<>
							<label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-line px-3 py-2">
								<Icon name="Search" size={18} className="text-muted" />
								<input className="w-full bg-transparent outline-none" placeholder="Search descriptions or merchants" value={text} onChange={(e) => setText(e.target.value)} />
							</label>
							<button className="flex items-center gap-1.5 rounded-lg border border-primary px-3 py-2 text-sm font-medium text-primary disabled:opacity-50" disabled={exportState === "Exporting…"}
								onClick={async () => {
									setExportState("Exporting…");
									try { const f = await download(filters); setExportState(`Downloaded ${f.rows} rows${f.truncated ? " (truncated)" : ""}`); } catch (e) { setExportState(errorText(e, "Couldn't export")); }
								}}>
								<Icon name="Download" size={16} />Export CSV
							</button>
						</>
					)}
				</div>
				{view === "all" && (
					<div className="flex flex-wrap items-center gap-2">
						<Chip>{PERIODS.find((p) => p.id === period)!.label}</Chip>
						{flow && <Chip onClear={() => setFlow(undefined)}>{FLOW_LABELS[flow]}</Chip>}
						{accountId && <Chip onClear={() => setAccountId(undefined)}>{accountLabel(byId.get(accountId), accountId)}</Chip>}
						<button className="flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-sm" aria-expanded={filtering} onClick={() => setFiltering(!filtering)}>
							<Icon name="SlidersHorizontal" size={14} />Filter
						</button>
						{exportState && <span className="text-sm text-muted" role="status">{exportState}</span>}
					</div>
				)}
				{view === "all" && filtering && (
					<div className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-3">
						<label className="text-sm text-muted">Period
							<select className="mt-1 w-full rounded-md border border-line bg-bg px-2 py-1.5 text-ink" value={period} onChange={(e) => setPeriod(e.target.value as PeriodId)}>
								{PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
							</select>
						</label>
						<label className="text-sm text-muted">Flow
							<select className="mt-1 w-full rounded-md border border-line bg-bg px-2 py-1.5 text-ink" value={flow ?? ""} onChange={(e) => setFlow(e.target.value || undefined)}>
								<option value="">All flows</option>
								{FLOWS.map((f) => <option key={f} value={f}>{FLOW_LABELS[f]}</option>)}
							</select>
						</label>
						<label className="text-sm text-muted">Account
							<select className="mt-1 w-full rounded-md border border-line bg-bg px-2 py-1.5 text-ink" value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value || undefined)}>
								<option value="">All accounts</option>
								{(accounts.data ?? []).filter((a) => a.has_transactions).map((a) => <option key={a.id} value={a.id}>{a.bank} · {accountLabel(a, a.id)}</option>)}
							</select>
						</label>
					</div>
				)}
				{view === "review" ? <ReviewList accounts={byId} selected={selectedId} onSelect={(t) => setSelectedId(t.id)} /> : (
					<Loaded result={search} height="h-64">
						{(data) => rows.length === 0 ? <p className="px-2 py-6 text-muted">No transactions match.</p> : (
							<>
								<DayGroups rows={rows} accounts={byId} selected={selectedId} onSelect={(t) => setSelectedId(t.id)} />
								{data.truncated && <p className="text-sm text-muted">Showing the newest {data.count}. Narrow the period to see older ones.</p>}
							</>
						)}
					</Loaded>
				)}
			</div>
			{selected && <Detail t={selected} accounts={byId} onClose={() => setSelectedId(undefined)} />}
		</div>
	);
}
