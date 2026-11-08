import { useEffect, useState, type ReactNode } from "react";
import { type Infer } from "apps";
import { queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { netWorth } from "../tools/accounts.js";
import type { cashflow, recurring } from "../tools/insights.js";
import type { cases } from "../tools/review.js";
import { CashflowOut, NetWorthOut, RecurringOut, ReviewCasesOut } from "../schemas.js";
import { addDays, Card, client, compact, dayLabel, FlowIcon, Icon, Loaded, money, monthLabel, nzToday, signed, type Result } from "./shared.js";
import { categoryIconName } from "./transaction-icon.js";

export const cashflowAtom = client.queryAtom(queryReference<typeof cashflow>("insights.cashflow"), { months: 6 }, CashflowOut);
export const netWorthAtom = client.queryAtom(queryReference<typeof netWorth>("accounts.netWorth"), {}, NetWorthOut);
// With the user's decisions, so a decided pair can be changed as a pair; toReview drops them.
export const reviewAtom = client.queryAtom(queryReference<typeof cases>("review.cases"), { include_reviewed: true }, ReviewCasesOut);
export const toReview = (data: Infer<typeof ReviewCasesOut>) => data.cases.filter((k) => k.reason !== "reviewed");
const recurringAtom = client.queryAtom(queryReference<typeof recurring>("insights.recurring"), { months: 13, min_occurrences: 3 }, RecurringOut);

const UPCOMING_DAYS = 14;
type Flow = Infer<typeof CashflowOut>["currencies"][number];

// One currency at a time; NZD first. Totals are never added across currencies.
function useCurrency<T extends { currency: string }>(currencies: readonly T[]) {
	const [picked, setPicked] = useState<string>();
	const current = currencies.find((c) => c.currency === picked) ?? currencies.find((c) => c.currency === "NZD") ?? currencies[0];
	const picker = currencies.length > 1 && (
		<div className="flex gap-1.5" role="group" aria-label="Currency">
			{currencies.map((c) => (
				<button key={c.currency} onClick={() => setPicked(c.currency)} aria-pressed={c === current}
					className={`rounded-full px-3 py-1 text-xs ${c === current ? "bg-ink text-bg" : "border border-line"}`}>{c.currency}</button>
			))}
		</div>
	);
	return { current, picker };
}

// stack: on phones, label and value share one row so wide amounts never collide.
function Stat({ label, value, tone = "", size = "text-2xl", stack = false }: { label: string; value: string; tone?: string; size?: string; stack?: boolean }) {
	return (
		<div className={stack ? "max-sm:flex max-sm:items-baseline max-sm:justify-between" : ""}>
			<div className="text-sm text-muted">{label}</div>
			<div className={`mt-1 font-semibold ${size} ${tone} ${stack ? "max-sm:mt-0 max-sm:text-xl" : ""}`}>{value}</div>
		</div>
	);
}

function Hero({ flow, month, picker }: { flow: Flow; month: string; picker: ReactNode }) {
	const m = flow.months.find((x) => x.month === month);
	if (!m) return null;
	return (
		<Card className="grid items-center gap-6 sm:grid-cols-[1.3fr_repeat(3,1fr)] sm:divide-x sm:divide-line">
			<div>
				<div className="flex items-center justify-between gap-3">
					<div className="font-medium">Net {m.partial ? "this month so far" : "for the month"}</div>
					{picker}
				</div>
				<div className={`mt-1 text-[40px] leading-tight font-bold tracking-tight max-sm:text-[34px] ${m.net < 0 ? "text-spending" : ""}`}>{signed(m.net, flow.currency)}</div>
				<div className="mt-1 text-sm text-muted">
					{m.transfers_left_out} transfer{m.transfers_left_out === 1 ? "" : "s"} between your accounts left out{m.excluded_by_rules ? ` · ${m.excluded_by_rules} excluded by your rules` : ""}
				</div>
			</div>
			<div className="flex flex-col gap-2 sm:contents">
				<div className="sm:pl-6"><Stat label="Income" value={money(m.income, flow.currency)} tone="text-income" stack /></div>
				<div className="sm:pl-6"><Stat label="Spending" value={money(-m.spending, flow.currency)} tone="text-spending" stack /></div>
				<div className="sm:pl-6"><Stat label="Saving" value={money(-m.saving, flow.currency)} tone="text-saving" stack /></div>
			</div>
		</Card>
	);
}

function ReviewBanner({ onReview }: { onReview: () => void }) {
	const review = useAppQuery(reviewAtom);
	const n = review.data ? toReview(review.data).length : 0;
	if (!n) return null;
	return (
		<button onClick={onReview} className="flex w-full items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-left">
			<Icon name="TriangleAlert" className="text-warning" />
			<span className="flex-1 font-medium">{n} flow{n === 1 ? "" : "s"} need{n === 1 ? "s" : ""} review</span>
			<span className="font-medium text-primary">Review</span>
			<Icon name="ChevronRight" size={18} className="text-primary" />
		</button>
	);
}

function useNarrow() {
	const query = "(max-width: 639px)";
	const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
	useEffect(() => {
		const m = matchMedia(query), update = () => setNarrow(m.matches);
		m.addEventListener("change", update);
		return () => m.removeEventListener("change", update);
	}, []);
	return narrow;
}

function MonthsChart({ flow, month, onMonth }: { flow: Flow; month: string; onMonth: (m: string) => void }) {
	// A smaller drawing on phones keeps the 11-12px labels close to their real size.
	const narrow = useNarrow();
	const W = narrow ? 340 : 720, H = narrow ? 180 : 200, left = narrow ? 44 : 52, bottom = 26, top = 8;
	const max = Math.max(1, ...flow.months.flatMap((m) => [m.income, -m.spending]));
	const step = 10 ** Math.floor(Math.log10(max)) / 2;
	const ceiling = Math.ceil(max / step) * step;
	const y = (v: number) => top + (H - top - bottom) * (1 - v / ceiling);
	const slot = (W - left) / flow.months.length, bar = Math.min(40, slot / 4);
	return (
		<svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Income and spending per month in ${flow.currency}`}>
			<defs>
				{(["income", "spending"] as const).map((k) => (
					<pattern key={k} id={`hatch-${k}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
						<rect width="6" height="6" fill={`var(--${k})`} opacity="0.2" />
						<line x1="0" y1="0" x2="0" y2="6" stroke={`var(--${k})`} strokeWidth="3" />
					</pattern>
				))}
			</defs>
			{[0, 0.25, 0.5, 0.75, 1].map((f) => (
				<g key={f}>
					<line x1={left} x2={W} y1={y(ceiling * f)} y2={y(ceiling * f)} stroke="var(--line)" strokeDasharray={f ? "3 4" : undefined} />
					<text x={left - 8} y={y(ceiling * f) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{compact(ceiling * f, flow.currency)}</text>
				</g>
			))}
			{flow.months.map((m, i) => {
				const x = left + slot * i + slot / 2, selected = m.month === month;
				return (
					<g key={m.month} onClick={() => onMonth(m.month)} className="cursor-pointer">
						<title>{`${monthLabel(m.month)}: in ${money(m.income, flow.currency)}, spent ${money(-m.spending, flow.currency)}${m.partial ? " (so far)" : ""}`}</title>
						<rect x={left + slot * i + 6} y={top} width={slot - 12} height={H - top - bottom} rx="8" fill={selected ? "var(--soft)" : "transparent"} />
						<rect x={x - bar - 2} y={y(m.income)} width={bar} height={y(0) - y(m.income)} rx="2" fill={m.partial ? "url(#hatch-income)" : "var(--income)"} />
						<rect x={x + 2} y={y(-m.spending)} width={bar} height={y(0) - y(-m.spending)} rx="2" fill={m.partial ? "url(#hatch-spending)" : "var(--spending)"} />
						<text x={x} y={H - 7} textAnchor="middle" fontSize="12" fontWeight={selected ? 600 : 400} fill={selected ? "var(--ink)" : "var(--muted)"}>{monthLabel(m.month, "short")}</text>
					</g>
				);
			})}
		</svg>
	);
}

function TopSpending({ flow, month }: { flow: Flow; month: string }) {
	const m = flow.months.find((x) => x.month === month);
	// Largest first, whatever order the tool returns.
	const top = [...(m?.top_spending ?? [])].sort((a, b) => b.amount - a.amount);
	const max = Math.max(1, ...top.map((c) => c.amount));
	return (
		<Card title="Top spending" aside={m && <span className="text-sm text-muted">{monthLabel(month)}</span>}>
			{top.length === 0 ? <p className="text-sm text-muted">No spending this month yet.</p> : (
				<ul className="flex flex-col gap-3">
					{top.map((c) => (
						<li key={c.category} className="flex items-center gap-3">
							<FlowIcon name={categoryIconName(c.category)} flow="spending" />
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline justify-between gap-3">
									<span className="truncate">{c.category}</span>
									<span className="shrink-0 font-medium">{money(c.amount, flow.currency)}</span>
								</div>
								<div className="mt-1.5 h-1.5 rounded-full bg-soft"><div className="h-full rounded-full bg-spending" style={{ width: `${(c.amount / max) * 100}%` }} /></div>
							</div>
						</li>
					))}
				</ul>
			)}
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
					if (due.length === 0) return <p className="text-sm text-muted">No regular payments expected in the next {UPCOMING_DAYS} days.</p>;
					return (
						<>
							<ul className="divide-y divide-line">
								{due.map((p) => (
									<li key={`${p.payee}|${p.currency}`} className="flex items-center gap-3 py-2.5">
										<FlowIcon name={categoryIconName(p.category, "")} flow="spending" />
										<div className="min-w-0 flex-1">
											<div className="truncate">{p.payee}</div>
											<div className="text-sm text-muted capitalize">{p.cadence}</div>
										</div>
										<span className="w-16 text-sm text-muted">{dayLabel(p.next_expected!)}</span>
										<span className="font-medium">{p.amount_varies ? "≈ " : ""}{money(-p.typical_amount, p.currency)}</span>
									</li>
								))}
							</ul>
							<p className="mt-2 text-xs text-muted">Predicted from past payments, not from your bank's schedule.</p>
						</>
					);
				}}
			</Loaded>
		</Card>
	);
}

function Balances({ onAccounts }: { onAccounts: () => void }) {
	const result = useAppQuery(netWorthAtom);
	return (
		<Card title="Balances" aside={<button className="text-sm font-medium text-primary" onClick={onAccounts}>Accounts</button>}>
			<Loaded result={result} height="h-14">
				{(data) => data.currencies.length === 0 ? <p className="text-sm text-muted">No balances yet.</p> : (
					<div className="flex flex-col gap-4">
						{data.currencies.map((c) => (
							<div key={c.currency} className="grid grid-cols-4 gap-4 max-sm:grid-cols-2">
								<Stat label={`Cash${data.currencies.length > 1 ? ` (${c.currency})` : ""}`} value={money(c.cash, c.currency)} size="text-xl" />
								<Stat label="Other assets" value={money(c.other_assets, c.currency)} size="text-xl" />
								<Stat label="Debt" value={money(c.debt, c.currency)} tone={c.debt ? "text-spending" : ""} size="text-xl" />
								<Stat label="Net" value={money(c.net, c.currency)} size="text-xl" />
							</div>
						))}
					</div>
				)}
			</Loaded>
		</Card>
	);
}

export function Home({ month, onMonth, go }: { month: string; onMonth: (m: string) => void; go: (path: string) => void }) {
	const result: Result<Infer<typeof CashflowOut>> = useAppQuery(cashflowAtom);
	const { current: flow, picker } = useCurrency(result.data?.currencies ?? []);
	return (
		<div className="flex flex-col gap-5">
			<Loaded result={result} height="h-36">
				{() => flow ? <Hero flow={flow} month={month} picker={picker} /> : <Card><p className="text-sm text-muted">No settled transactions in the last 6 months.</p></Card>}
			</Loaded>
			<ReviewBanner onReview={() => go("transactions?view=review")} />
			{flow && (
				<Card title="Last 6 months" aside={
					<div className="flex gap-4 text-sm text-muted">
						<span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-income" />Income</span>
						<span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-spending" />Spending</span>
					</div>
				}>
					<MonthsChart flow={flow} month={month} onMonth={onMonth} />
					<p className="mt-1 text-xs text-muted">Hatched: the month so far. Transfers between your own accounts and saving are not spending, as on the phone.</p>
				</Card>
			)}
			<div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
				{flow ? <TopSpending flow={flow} month={month} /> : <div />}
				<UpcomingBills />
			</div>
			<Balances onAccounts={() => go("accounts")} />
		</div>
	);
}
