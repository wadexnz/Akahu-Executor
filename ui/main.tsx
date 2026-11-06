import { StrictMode, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { array, boolean, number, object, type Infer } from "apps";
import { createAppClient, mutationReference, queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { listAccounts } from "../tools/accounts.js";
import type { budgetStatus, cashflow, recurring } from "../tools/insights.js";
import type { setBudget } from "../tools/memory.js";
import type { acknowledge, balanceHistory, listAlerts } from "../tools/monitor.js";
import { AccountOut, Alert, BalanceHistoryOut, Budget, BudgetStatusOut, CashflowOut, RecurringOut } from "../schemas.js";
import "./style.css";

// Every read goes through the app's own tools as the signed-in member, with their Akahu connection.
const client = createAppClient();
const accountsAtom = client.queryAtom(queryReference<typeof listAccounts>("accounts.list"), {}, array(AccountOut));
const historyAtom = client.queryAtom(queryReference<typeof balanceHistory>("monitor.balanceHistory"), { days: 30 }, BalanceHistoryOut);
const cashflowAtom = client.queryAtom(queryReference<typeof cashflow>("insights.cashflow"), { months: 6 }, CashflowOut);
const recurringAtom = client.queryAtom(queryReference<typeof recurring>("insights.recurring"), { months: 13, min_occurrences: 3 }, RecurringOut);
const alertsAtom = client.queryAtom(queryReference<typeof listAlerts>("monitor.alerts"), { include_acknowledged: false, limit: 50 }, array(Alert));
const budgetRef = queryReference<typeof budgetStatus>("insights.budgetStatus");
const setBudgetRef = mutationReference<typeof setBudget>("memory.setBudget");
const acknowledgeRef = mutationReference<typeof acknowledge>("monitor.acknowledge");

const UPCOMING_DAYS = 14;
const nzToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date());
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const money = (n: number, currency: string, digits = 2) =>
	new Intl.NumberFormat("en-NZ", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const utc = (iso: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-NZ", { ...options, timeZone: "UTC" }).format(new Date(iso));
const monthLabel = (month: string, style: "long" | "short" = "long") => utc(`${month}-01T00:00:00Z`, { month: style, year: "numeric" });
const dayLabel = (day: string) => utc(`${day}T00:00:00Z`, { day: "numeric", month: "short" });

function Card({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={`rounded-2xl border border-line bg-white/80 p-6 shadow-[0_1px_2px_rgba(31,42,68,0.04)] ${className}`}>
			<div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 className="font-display text-[26px] leading-tight font-semibold">{title}</h2>
				{aside}
			</div>
			{children}
		</section>
	);
}

// A failed or slow read stays inside its own card; the rest of the page keeps working.
function Loaded<T>({ result, children }: { result: { data: T | undefined; pending: boolean; error?: string }; children: (data: T) => ReactNode }) {
	if (result.data !== undefined) {
		return (
			<>
				{result.error && <p className="mb-2 text-xs text-spend" role="alert">Showing earlier data: {result.error}</p>}
				{children(result.data)}
			</>
		);
	}
	if (result.error) return <p className="py-6 text-sm text-spend" role="alert">Couldn't load this from Akahu: {result.error}</p>;
	return <div className="h-32 animate-pulse rounded-xl bg-line/50" aria-label="Loading" />;
}

function Header({ month, months, onMonth, elapsed }: { month: string; months: string[]; onMonth: (m: string) => void; elapsed: number | undefined }) {
	const i = months.indexOf(month);
	const arrow = "grid h-10 w-10 place-items-center rounded-full border border-line bg-white text-lg disabled:opacity-30";
	return (
		<div className="flex items-center gap-4">
			<button className={arrow} aria-label="Previous month" disabled={i <= 0} onClick={() => onMonth(months[i - 1]!)}>‹</button>
			<div>
				<h1 className="font-display text-[40px] leading-none font-semibold tracking-tight max-sm:text-[28px]">{monthLabel(month)}</h1>
				<div className="mt-2 flex items-center gap-3 text-sm text-muted">
					{elapsed === undefined ? <span>&nbsp;</span> : elapsed >= 100 ? <span>Full month</span> : (
						<>
							<span>Month {Math.round(elapsed)}% elapsed</span>
							<span className="h-1.5 w-40 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-income" style={{ width: `${elapsed}%` }} /></span>
						</>
					)}
				</div>
			</div>
			<button className={arrow} aria-label="Next month" disabled={i < 0 || i >= months.length - 1} onClick={() => onMonth(months[i + 1]!)}>›</button>
		</div>
	);
}

function Alerts() {
	const alerts = useAppQuery(alertsAtom);
	const [open, setOpen] = useState(false);
	const [failure, setFailure] = useState<string>();
	const list = alerts.data ?? [];
	const seen = async (ids: string[]) => {
		setFailure(undefined);
		try {
			await client.mutate(acknowledgeRef, { alert_ids: ids }, object({ acknowledged: number() }));
		} catch {
			setFailure("Couldn't mark that as seen. Try again.");
		}
	};
	return (
		<div className="relative">
			<button
				className={`rounded-full px-5 py-2.5 text-sm font-medium ${list.length ? "bg-spend/15 text-[#c0533f]" : "bg-white text-muted border border-line"}`}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{alerts.pending ? "Alerts…" : list.length ? `🔔 ${list.length} alert${list.length === 1 ? "" : "s"}` : "No new alerts"}
			</button>
			{open && (
				<div className="absolute right-0 z-10 mt-2 w-[min(420px,90vw)] rounded-2xl border border-line bg-white p-4 shadow-lg">
					{alerts.error && <p className="text-sm text-spend">{alerts.error}</p>}
					{failure && <p className="text-sm text-spend" role="alert">{failure}</p>}
					{list.length === 0 ? <p className="text-sm text-muted">Nothing new. The daily check raises alerts here.</p> : (
						<>
							<ul className="divide-y divide-line">
								{list.map((a) => (
									<li key={a.id} className="flex items-start gap-3 py-3">
										<div className="min-w-0 flex-1">
											<div className="text-xs font-medium tracking-wide text-muted uppercase">{a.kind.replaceAll("_", " ")} · {dayLabel(a.created_at.slice(0, 10))}</div>
											<p className="mt-0.5 text-sm">{a.message}</p>
										</div>
										<button className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs" onClick={() => seen([a.id])}>Mark seen</button>
									</li>
								))}
							</ul>
							{list.length > 1 && <button className="mt-2 text-xs text-muted underline" onClick={() => seen(list.map((a) => a.id))}>Mark all seen</button>}
						</>
					)}
				</div>
			)}
		</div>
	);
}

type Flow = Infer<typeof CashflowOut>["currencies"][number];

function CashflowChart({ flow, month, onMonth }: { flow: Flow; month: string; onMonth: (m: string) => void }) {
	const W = 720, H = 220, left = 56, bottom = 28, top = 8;
	const max = Math.max(1, ...flow.months.flatMap((m) => [m.income, -m.spending]));
	const step = 10 ** Math.floor(Math.log10(max));
	const ceiling = Math.ceil(max / step) * step;
	const y = (v: number) => top + (H - top - bottom) * (1 - v / ceiling);
	const slot = (W - left) / flow.months.length, bar = Math.min(48, slot / 3);
	return (
		<svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Income and spending per month in ${flow.currency}`}>
			<defs>
				{(["income", "spend"] as const).map((k) => (
					<pattern key={k} id={`hatch-${k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
						<rect width="6" height="6" fill={`var(--color-${k})`} opacity="0.25" />
						<line x1="0" y1="0" x2="0" y2="6" stroke={`var(--color-${k})`} strokeWidth="3" />
					</pattern>
				))}
			</defs>
			{[0, 0.25, 0.5, 0.75, 1].map((f) => (
				<g key={f}>
					<line x1={left} x2={W} y1={y(ceiling * f)} y2={y(ceiling * f)} stroke="var(--color-line)" />
					<text x={left - 8} y={y(ceiling * f) + 4} textAnchor="end" fontSize="11" fill="var(--color-muted)">{money(ceiling * f, flow.currency, 0)}</text>
				</g>
			))}
			{flow.months.map((m, i) => {
				const x = left + slot * i + slot / 2;
				const selected = m.month === month;
				return (
					<g key={m.month} onClick={() => onMonth(m.month)} className="cursor-pointer">
						<title>{`${monthLabel(m.month)}: in ${money(m.income, flow.currency)}, out ${money(-m.spending, flow.currency)}${m.partial ? " (so far)" : ""}`}</title>
						<rect x={left + slot * i + 4} y={top} width={slot - 8} height={H - top - bottom} rx="10" fill={selected ? "#f1eee6" : "transparent"} />
						<rect x={x - bar - 3} y={y(m.income)} width={bar} height={y(0) - y(m.income)} rx="3" fill={m.partial ? "url(#hatch-income)" : "var(--color-income)"} />
						<rect x={x + 3} y={y(-m.spending)} width={bar} height={y(0) - y(-m.spending)} rx="3" fill={m.partial ? "url(#hatch-spend)" : "var(--color-spend)"} />
						<text x={x} y={H - 8} textAnchor="middle" fontSize="12" fontWeight={selected ? 600 : 400} fill={selected ? "var(--color-ink)" : "var(--color-muted)"}>{monthLabel(m.month, "short")}</text>
					</g>
				);
			})}
		</svg>
	);
}

function Cashflow({ month, onMonth }: { month: string; onMonth: (m: string) => void }) {
	const result = useAppQuery(cashflowAtom);
	const [picked, setPicked] = useState<string>();
	const legend = (
		<div className="flex gap-5 text-sm text-muted">
			<span className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-income" />Income</span>
			<span className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full bg-spend" />Spending</span>
		</div>
	);
	return (
		<Card title="Cashflow" aside={legend}>
			<Loaded result={result}>
				{(data) => {
					if (data.currencies.length === 0) return <p className="text-sm text-muted">No settled transactions in the last 6 months.</p>;
					const flow = data.currencies.find((c) => c.currency === picked) ?? data.currencies.find((c) => c.currency === "NZD") ?? data.currencies[0]!;
					const m = flow.months.find((x) => x.month === month);
					return (
						<>
							{data.currencies.length > 1 && (
								<div className="mb-3 flex gap-2">
									{data.currencies.map((c) => (
										<button key={c.currency} onClick={() => setPicked(c.currency)} className={`rounded-full px-3 py-1 text-xs ${c === flow ? "bg-ink text-white" : "border border-line"}`}>{c.currency}</button>
									))}
								</div>
							)}
							<CashflowChart flow={flow} month={month} onMonth={onMonth} />
							{m && (
								<p className="mt-3 text-sm text-muted">
									{monthLabel(m.month)}{m.partial ? " so far" : ""}: <b className="text-ink">{money(m.income, flow.currency)}</b> in, <b className="text-ink">{money(-m.spending, flow.currency)}</b> out,
									net <b className={m.net < 0 ? "text-[#c0533f]" : "text-ink"}>{money(m.net, flow.currency)}</b>.
									{" "}{m.transfers_left_out} transfer{m.transfers_left_out === 1 ? "" : "s"} between your own accounts left out{m.excluded_by_rules ? `, ${m.excluded_by_rules} excluded by your rules` : ""}.
								</p>
							)}
						</>
					);
				}}
			</Loaded>
		</Card>
	);
}

function BudgetEditor({ group, currency, current, onDone }: { group: string; currency: string; current?: number; onDone: () => void }) {
	const [value, setValue] = useState(current === undefined ? "" : String(current));
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string>();
	return (
		<form
			className="flex items-center gap-2"
			onSubmit={async (event) => {
				event.preventDefault();
				const amount = Number(value);
				if (!(amount >= 0) || saving) return;
				setSaving(true);
				setFailure(undefined);
				try {
					await client.mutate(setBudgetRef, { group, monthly_amount: amount, currency }, object({ budget: Budget.optional(), removed: boolean() }));
					onDone();
				} catch {
					setFailure("Couldn't save");
				} finally {
					setSaving(false);
				}
			}}
		>
			<input
				className="w-28 rounded-lg border border-line bg-white px-2 py-1 text-sm"
				inputMode="decimal" aria-label={`Monthly budget for ${group} in ${currency}`} autoFocus
				value={value} onChange={(e) => setValue(e.target.value)} placeholder="Monthly"
			/>
			<button className="rounded-lg bg-ink px-3 py-1 text-xs text-white disabled:opacity-50" disabled={saving || value === "" || !(Number(value) >= 0)}>{saving ? "Saving…" : "Save"}</button>
			<button type="button" className="text-xs text-muted" onClick={onDone}>Cancel</button>
			{failure && <span className="text-xs text-spend" role="alert">{failure}</span>}
		</form>
	);
}

function BudgetRow({ group, currency, spent, budget, elapsed }: { group: string; currency: string; spent: number; budget?: number; elapsed: number }) {
	const [editing, setEditing] = useState(false);
	const used = budget ? (spent / budget) * 100 : 0;
	const status = budget === undefined ? undefined : used > 100 ? "Over budget" : used > elapsed + 15 ? "Ahead of pace" : undefined;
	const colour = status === "Over budget" ? "bg-spend" : status ? "bg-pace" : "bg-income";
	return (
		<li className="grid grid-cols-[minmax(90px,1fr)_2fr_190px] items-center gap-4 py-3 max-sm:grid-cols-[1fr_auto] max-sm:gap-y-2">
			<span className="font-medium">{group}</span>
			{budget === undefined ? <span className="text-xs text-muted max-sm:order-last max-sm:col-span-2">No budget</span> : (
				<div className="relative h-3 rounded-full bg-line/70 max-sm:order-last max-sm:col-span-2">
					<div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.min(100, used)}%` }} />
					<div className="absolute -top-1.5 -bottom-1.5 border-l-2 border-dotted border-ink" style={{ left: `${elapsed}%` }} title={`${Math.round(elapsed)}% of the month`} />
				</div>
			)}
			<div className="text-right">
				{editing ? <BudgetEditor group={group} currency={currency} current={budget} onDone={() => setEditing(false)} /> : (
					<button className="text-right" onClick={() => setEditing(true)} title={budget === undefined ? "Set a monthly budget" : "Change the budget (0 removes it)"}>
						<b>{money(spent, currency)}</b>
						{budget === undefined ? <span className="ml-2 text-xs text-muted underline">Set budget</span> : <span className="text-muted"> of {money(budget, currency)}</span>}
					</button>
				)}
				{status && !editing && <div className={`text-xs ${status === "Over budget" ? "text-[#c0533f]" : "text-[#b7791f]"}`}>{status}</div>}
			</div>
		</li>
	);
}

function Budgets({ result }: { result: { data: Infer<typeof BudgetStatusOut> | undefined; pending: boolean; error?: string } }) {
	return (
		<Card title="Budgets" aside={result.data && <span className="text-sm text-muted">Dotted line: {Math.round(result.data.month_elapsed_percent)}% of the month</span>}>
			<Loaded result={result}>
				{(data) => (
					<>
						{data.budgets.length === 0 && <p className="mb-1 text-sm text-muted">No budgets yet. Pick a group below to set one, or ask your agent.</p>}
						<ul className="divide-y divide-line">
							{data.budgets.map((b) => <BudgetRow key={`${b.group}|${b.currency}`} group={b.group} currency={b.currency} spent={b.spent} budget={b.budget} elapsed={data.month_elapsed_percent} />)}
							{data.unbudgeted.slice(0, 6).map((b) => <BudgetRow key={`${b.group}|${b.currency}`} group={b.group} currency={b.currency} spent={b.spent} elapsed={data.month_elapsed_percent} />)}
						</ul>
						{data.budgets.length === 0 && data.unbudgeted.length === 0 && <p className="text-sm text-muted">No spending in a category group this month yet.</p>}
					</>
				)}
			</Loaded>
		</Card>
	);
}

function UpcomingBills() {
	const result = useAppQuery(recurringAtom);
	const today = nzToday(), until = addDays(today, UPCOMING_DAYS);
	return (
		<Card title="Upcoming bills" aside={<span className="text-sm text-muted">Next {UPCOMING_DAYS} days</span>}>
			<Loaded result={result}>
				{(data) => {
					const due = data.payments
						.filter((p) => p.status === "active" && p.next_expected !== undefined && p.next_expected >= today && p.next_expected <= until)
						.sort((a, b) => a.next_expected!.localeCompare(b.next_expected!));
					const totals = new Map<string, number>();
					for (const p of due) totals.set(p.currency, (totals.get(p.currency) ?? 0) - p.typical_amount);
					if (due.length === 0) return <p className="text-sm text-muted">No regular payments expected in the next {UPCOMING_DAYS} days.</p>;
					return (
						<>
							<ul className="divide-y divide-line">
								{due.map((p) => (
									<li key={`${p.payee}|${p.currency}`} className="flex items-center gap-4 py-2.5">
										<span className="w-[76px] shrink-0 rounded-lg bg-paper px-2 py-1 text-center leading-tight whitespace-nowrap">
											<span className="block text-[11px] text-muted">{utc(`${p.next_expected}T00:00:00Z`, { weekday: "short" })}</span>
											<span className="text-sm">{dayLabel(p.next_expected!)}</span>
										</span>
										<span className="min-w-0 flex-1 truncate font-medium" title={`${p.cadence}, ${p.occurrences} payments so far`}>{p.payee}</span>
										<span>{p.amount_varies ? "≈ " : ""}{money(-p.typical_amount, p.currency)}</span>
									</li>
								))}
							</ul>
							<div className="mt-3 rounded-xl bg-paper px-4 py-3">
								{[...totals].map(([currency, total]) => (
									<div key={currency}><b className="text-xl">{money(total, currency)}</b> <span className="text-sm text-muted">expected in the next {UPCOMING_DAYS} days</span></div>
								))}
								<p className="mt-1 text-xs text-muted">Predicted from past payments, not from your bank's schedule.</p>
							</div>
						</>
					);
				}}
			</Loaded>
		</Card>
	);
}

function Sparkline({ points, negative }: { points: number[]; negative: boolean }) {
	if (points.length < 2) return <div className="flex h-10 items-center" title="The chart starts once the daily check has run on two days"><div className="w-full border-t-2 border-dashed border-line" /></div>;
	const W = 200, H = 40, lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
	const path = points.map((v, i) => `${i ? "L" : "M"}${(i / (points.length - 1)) * W},${H - 4 - ((v - lo) / span) * (H - 8)}`).join(" ");
	return (
		<svg viewBox={`0 0 ${W} ${H}`} className="h-10 w-full" aria-hidden="true">
			<path d={path} fill="none" stroke={negative ? "var(--color-spend)" : "var(--color-income)"} strokeWidth="2" strokeLinejoin="round" />
		</svg>
	);
}

function Balances() {
	const accounts = useAppQuery(accountsAtom);
	const history = useAppQuery(historyAtom);
	const since = history.data?.totals.flatMap((t) => t.days.map((d) => d.day)).sort()[0];
	return (
		<Card title="Balances" aside={since && <span className="text-sm text-muted">Daily history since {dayLabel(since)}{history.data!.totals.every((t) => t.days.length < 2) ? "; charts start from the second day" : ""}</span>}>
			<Loaded result={accounts}>
				{(list) => {
					const withBalance = list.filter((a) => a.balance);
					const worth = new Map<string, number>();
					for (const a of withBalance) worth.set(a.balance!.currency, (worth.get(a.balance!.currency) ?? 0) + a.balance!.current);
					const series = (id: string) => history.data?.accounts.find((h) => h.account_id === id)?.snapshots.map((s) => s.current) ?? [];
					return (
						<div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
							{withBalance.map((a) => (
								<div key={a.id} className="rounded-xl border border-line bg-white p-4">
									<div className="truncate text-sm font-medium" title={`${a.name} · ${a.bank}`}>{a.name}</div>
									<div className="truncate text-xs text-muted">{a.bank}{a.status === "INACTIVE" ? " · not syncing" : ""}</div>
									<div className={`mt-1 text-xl font-semibold ${a.balance!.current < 0 ? "text-[#c0533f]" : ""}`}>{money(a.balance!.current, a.balance!.currency)}</div>
									<Sparkline points={series(a.id)} negative={a.balance!.current < 0} />
								</div>
							))}
							{[...worth].map(([currency, total]) => (
								<div key={currency} className="rounded-xl border border-income/30 bg-income/10 p-4">
									<div className="text-sm font-medium">Net worth{worth.size > 1 ? ` (${currency})` : ""}</div>
									<div className="text-xs text-muted">All accounts, debts negative</div>
									<div className="mt-1 text-xl font-semibold">{money(total, currency)}</div>
									<Sparkline points={history.data?.totals.find((t) => t.currency === currency)?.days.map((d) => d.current) ?? []} negative={total < 0} />
								</div>
							))}
						</div>
					);
				}}
			</Loaded>
		</Card>
	);
}

function MonthlyReview() {
	const currentMonth = nzToday().slice(0, 7);
	const [month, setMonth] = useState(currentMonth);
	const flow = useAppQuery(cashflowAtom);
	const budgetAtom = useMemo(() => client.queryAtom(budgetRef, { month }, BudgetStatusOut), [month]);
	const budget = useAppQuery(budgetAtom);
	const months = flow.data?.currencies[0]?.months.map((m) => m.month) ?? [currentMonth];
	return (
		<main className="mx-auto flex max-w-[1240px] flex-col gap-6 px-6 py-8 max-sm:px-4">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<Header month={month} months={months} onMonth={setMonth} elapsed={budget.data?.month === month ? budget.data.month_elapsed_percent : undefined} />
				<Alerts />
			</header>
			<Cashflow month={month} onMonth={setMonth} />
			<div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
				<Budgets result={budget} />
				<UpcomingBills />
			</div>
			<Balances />
			<footer className="pb-4 text-xs text-muted">Read-only view of your Akahu data. Akahu syncs banks about once a day; flows follow the mobile app: transfers between your own accounts and saving are left out of spending.</footer>
		</main>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
	<StrictMode>
		<MonthlyReview />
	</StrictMode>,
);
