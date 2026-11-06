import { useEffect, useMemo, useState } from "react";
import { array, boolean, number, object, type Infer } from "apps";
import { mutationReference, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { budgetStatus } from "../tools/insights.js";
import type { listRules, removeRule, setBudget } from "../tools/memory.js";
import type { acknowledge, listAlerts } from "../tools/monitor.js";
import { Alert, Budget, BudgetStatusOut, RemovedOut, RuleOut } from "../schemas.js";
import { Card, client, dayLabel, errorText, FLOW_LABELS, Icon, Loaded, money, monthLabel } from "./shared.js";

const rulesAtom = client.queryAtom(queryReference<typeof listRules>("memory.listRules"), {}, array(RuleOut));
export const alertsAtom = client.queryAtom(queryReference<typeof listAlerts>("monitor.alerts"), { include_acknowledged: false, limit: 50 }, array(Alert));
const budgetRef = queryReference<typeof budgetStatus>("insights.budgetStatus");
const removeRuleRef = mutationReference<typeof removeRule>("memory.removeRule");
const setBudgetRef = mutationReference<typeof setBudget>("memory.setBudget");
const acknowledgeRef = mutationReference<typeof acknowledge>("monitor.acknowledge");

// Theme: light, dark, or follow the system. Stored only in this browser.
export type Theme = "light" | "dark" | "system";
const THEME_KEY = "akahu-theme";
export const storedTheme = (): Theme => {
	const v = localStorage.getItem(THEME_KEY);
	return v === "light" || v === "dark" ? v : "system";
};
export function useTheme() {
	const [theme, setTheme] = useState<Theme>(storedTheme);
	useEffect(() => {
		const dark = matchMedia("(prefers-color-scheme: dark)");
		const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (dark.matches ? "dark" : "light") : theme; };
		apply();
		localStorage.setItem(THEME_KEY, theme);
		dark.addEventListener("change", apply);
		return () => dark.removeEventListener("change", apply);
	}, [theme]);
	return [theme, setTheme] as const;
}

const matchText = (m: Infer<typeof RuleOut>["match"]) => [
	m.description && `description contains “${m.description}”`,
	m.merchant && `merchant contains “${m.merchant}”`,
	m.other_account && `other account ${m.other_account}`,
	m.account_id && `account ${m.account_id}`,
	m.direction && `${m.direction}s only`,
].filter(Boolean).join(", ");

function Rules() {
	const rules = useAppQuery(rulesAtom);
	const [failure, setFailure] = useState<string>();
	const remove = async (rule_id: string) => {
		setFailure(undefined);
		try { await client.mutate(removeRuleRef, { rule_id }, RemovedOut); } catch (e) { setFailure(errorText(e, "Couldn't remove the rule.")); }
	};
	return (
		<Card title="Rules" aside={<span className="text-sm text-muted">First match wins; your own decisions win over rules</span>}>
			{failure && <p className="mb-2 text-sm text-danger" role="alert">{failure}</p>}
			<Loaded result={rules}>
				{(list) => list.length === 0 ? <p className="text-sm text-muted">No rules yet. Open a transaction and choose “Make a rule for similar transactions”.</p> : (
					<ul className="divide-y divide-line">
						{list.map((r, i) => (
							<li key={r.id} className="flex items-center gap-3 py-2.5">
								<span className="w-6 text-sm text-muted">{i + 1}</span>
								<div className="min-w-0 flex-1">
									<div className="truncate">{matchText(r.match)}</div>
									<div className="text-sm text-muted">{r.kind === "exclude" ? "Leave out of insights" : `Set to ${FLOW_LABELS[r.kind] ?? r.kind}`}{r.reason ? ` · ${r.reason}` : ""}</div>
								</div>
								<button aria-label="Remove rule" className="p-1 text-muted hover:text-danger" onClick={() => remove(r.id)}><Icon name="Trash2" size={18} /></button>
							</li>
						))}
					</ul>
				)}
			</Loaded>
		</Card>
	);
}

function BudgetEditor({ group, currency, current, onDone }: { group: string; currency: string; current?: number; onDone: () => void }) {
	const [value, setValue] = useState(current === undefined ? "" : String(current));
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string>();
	const valid = value !== "" && Number(value) >= 0;
	return (
		<form className="flex items-center justify-end gap-2" onSubmit={async (event) => {
			event.preventDefault();
			if (!valid || saving) return;
			setSaving(true); setFailure(undefined);
			try {
				await client.mutate(setBudgetRef, { group, monthly_amount: Number(value), currency }, object({ budget: Budget.optional(), removed: boolean() }));
				onDone();
			} catch (e) { setFailure(errorText(e, "Couldn't save")); } finally { setSaving(false); }
		}}>
			<input className="w-24 rounded-md border border-line bg-bg px-2 py-1 text-sm" inputMode="decimal" aria-label={`Monthly budget for ${group} in ${currency}`} autoFocus
				value={value} onChange={(e) => setValue(e.target.value)} placeholder="Monthly" />
			<button className="rounded-md bg-primary px-3 py-1 text-xs text-on-primary disabled:opacity-50" disabled={saving || !valid}>{saving ? "Saving…" : "Save"}</button>
			<button type="button" className="text-xs text-muted" onClick={onDone}>Cancel</button>
			{failure && <span className="text-xs text-danger" role="alert">{failure}</span>}
		</form>
	);
}

function BudgetRow({ group, currency, spent, budget, elapsed }: { group: string; currency: string; spent: number; budget?: number; elapsed: number }) {
	const [editing, setEditing] = useState(false);
	const used = budget ? (spent / budget) * 100 : 0;
	const status = budget === undefined ? undefined : used > 100 ? "Over budget" : used > elapsed + 15 ? "Ahead of pace" : undefined;
	const colour = status === "Over budget" ? "bg-danger" : status ? "bg-warning" : "bg-income";
	return (
		<li className="grid grid-cols-[minmax(90px,1fr)_2fr_200px] items-center gap-4 py-3 max-sm:grid-cols-[1fr_auto] max-sm:gap-y-2">
			<span className="font-medium">{group}</span>
			{budget === undefined ? <span className="text-xs text-muted max-sm:order-last max-sm:col-span-2">No budget</span> : (
				<div className="relative h-2.5 rounded-full bg-soft max-sm:order-last max-sm:col-span-2">
					<div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.min(100, used)}%` }} />
					<div className="absolute -top-1 -bottom-1 border-l-2 border-dotted border-ink" style={{ left: `${elapsed}%` }} title={`${Math.round(elapsed)}% of the month`} />
				</div>
			)}
			<div className="text-right">
				{editing ? <BudgetEditor group={group} currency={currency} current={budget} onDone={() => setEditing(false)} /> : (
					<button className="text-right" onClick={() => setEditing(true)} title={budget === undefined ? "Set a monthly budget" : "Change the budget (0 removes it)"}>
						<b>{money(spent, currency)}</b>
						{budget === undefined ? <span className="ml-2 text-xs text-primary">Set budget</span> : <span className="text-muted"> of {money(budget, currency)}</span>}
					</button>
				)}
				{status && !editing && <div className={`text-xs ${status === "Over budget" ? "text-danger" : "text-warning"}`}>{status}</div>}
			</div>
		</li>
	);
}

function Budgets({ month }: { month: string }) {
	const atom = useMemo(() => client.queryAtom(budgetRef, { month }, BudgetStatusOut), [month]);
	const result = useAppQuery(atom);
	return (
		<Card title="Budgets" aside={<span className="text-sm text-muted">{monthLabel(month)}{result.data ? ` · dotted line: ${Math.round(result.data.month_elapsed_percent)}% of the month` : ""}</span>}>
			<Loaded result={result}>
				{(data) => (
					<>
						{data.budgets.length === 0 && <p className="mb-1 text-sm text-muted">No budgets yet. Pick a group below to set one, or ask your agent.</p>}
						<ul className="divide-y divide-line">
							{data.budgets.map((b) => <BudgetRow key={`${b.group}|${b.currency}`} group={b.group} currency={b.currency} spent={b.spent} budget={b.budget} elapsed={data.month_elapsed_percent} />)}
							{data.unbudgeted.slice(0, 8).map((b) => <BudgetRow key={`${b.group}|${b.currency}`} group={b.group} currency={b.currency} spent={b.spent} elapsed={data.month_elapsed_percent} />)}
						</ul>
						{data.budgets.length === 0 && data.unbudgeted.length === 0 && <p className="text-sm text-muted">No spending in a category group this month yet.</p>}
					</>
				)}
			</Loaded>
		</Card>
	);
}

function Alerts() {
	const alerts = useAppQuery(alertsAtom);
	const [failure, setFailure] = useState<string>();
	const seen = async (alert_ids: string[]) => {
		setFailure(undefined);
		try { await client.mutate(acknowledgeRef, { alert_ids }, object({ acknowledged: number() })); } catch (e) { setFailure(errorText(e, "Couldn't mark that as seen.")); }
	};
	return (
		<Card title="Alerts" aside={alerts.data && alerts.data.length > 1 && <button className="text-sm font-medium text-primary" onClick={() => seen(alerts.data!.map((a) => a.id))}>Mark all seen</button>}>
			{failure && <p className="mb-2 text-sm text-danger" role="alert">{failure}</p>}
			<Loaded result={alerts}>
				{(list) => list.length === 0 ? <p className="text-sm text-muted">Nothing new. The daily check raises alerts here and in your agent.</p> : (
					<ul className="divide-y divide-line">
						{list.map((a) => (
							<li key={a.id} className="flex items-start gap-3 py-3">
								<Icon name="Bell" size={18} className="mt-0.5 text-warning" />
								<div className="min-w-0 flex-1">
									<div className="text-xs font-medium tracking-wide text-muted uppercase">{a.kind.replaceAll("_", " ")} · {dayLabel(a.created_at.slice(0, 10))}</div>
									<p className="mt-0.5 text-sm">{a.message}</p>
								</div>
								<button className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs" onClick={() => seen([a.id])}>Mark seen</button>
							</li>
						))}
					</ul>
				)}
			</Loaded>
		</Card>
	);
}

function ThemePicker({ theme, onTheme }: { theme: Theme; onTheme: (t: Theme) => void }) {
	const options = [["light", "Light", "Sun"], ["dark", "Dark", "Moon"], ["system", "System", "Monitor"]] as const;
	return (
		<Card title="Appearance">
			<div className="flex rounded-lg bg-soft p-1" role="group" aria-label="Theme">
				{options.map(([id, label, icon]) => (
					<button key={id} aria-pressed={theme === id} onClick={() => onTheme(id)}
						className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm ${theme === id ? "bg-bg font-medium shadow-[0_0_0_1px_var(--line)]" : "text-muted"}`}>
						<Icon name={icon} size={16} />{label}
					</button>
				))}
			</div>
		</Card>
	);
}

export function More({ month, theme, onTheme }: { month: string; theme: Theme; onTheme: (t: Theme) => void }) {
	return (
		<div className="flex flex-col gap-5 pb-8">
			<h1 className="text-3xl font-bold tracking-tight">More</h1>
			<Alerts />
			<Budgets month={month} />
			<Rules />
			<ThemePicker theme={theme} onTheme={onTheme} />
			<p className="text-xs text-muted">Rules, decisions, notes, tags and budgets are stored in this Executor app only; they are not shared with the mobile app.</p>
		</div>
	);
}
