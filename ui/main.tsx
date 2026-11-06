import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAppQuery } from "apps/react";
import { Accounts } from "./accounts.js";
import { cashflowAtom, Home } from "./home.js";
import { alertsAtom, More, useTheme } from "./more.js";
import { Icon, monthLabel, nzToday } from "./shared.js";
import { Transactions } from "./transactions.js";
import "./style.css";

const TABS = [
	{ id: "home", label: "Home", icon: "House" },
	{ id: "transactions", label: "Transactions", icon: "List" },
	{ id: "accounts", label: "Accounts", icon: "Landmark" },
	{ id: "more", label: "More", icon: "Ellipsis" },
] as const;
type Tab = (typeof TABS)[number]["id"];

// Pages live in the URL hash (#/transactions?view=review) so reload and back work.
function readRoute() {
	const [path = "", query = ""] = location.hash.replace(/^#\/?/, "").split("?");
	const tab: Tab = TABS.find((t) => t.id === path)?.id ?? "home";
	return { tab, view: new URLSearchParams(query).get("view") === "review" ? "review" as const : "all" as const };
}

function MonthPicker({ month, onMonth }: { month: string; onMonth: (m: string) => void }) {
	const flow = useAppQuery(cashflowAtom);
	const months = flow.data?.currencies[0]?.months.map((m) => m.month) ?? [month];
	const i = months.indexOf(month);
	const arrow = "grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-soft disabled:opacity-30";
	return (
		<div className="flex items-center gap-1">
			<button className={arrow} aria-label="Previous month" disabled={i <= 0} onClick={() => onMonth(months[i - 1]!)}><Icon name="ChevronLeft" size={18} /></button>
			<span className="min-w-[8.5rem] text-center font-medium">{monthLabel(month)}</span>
			<button className={arrow} aria-label="Next month" disabled={i < 0 || i >= months.length - 1} onClick={() => onMonth(months[i + 1]!)}><Icon name="ChevronRight" size={18} /></button>
		</div>
	);
}

function App() {
	const [route, setRoute] = useState(readRoute);
	const [month, setMonth] = useState(() => nzToday().slice(0, 7));
	const [theme, setTheme] = useTheme();
	const alerts = useAppQuery(alertsAtom);
	useEffect(() => {
		const update = () => { setRoute(readRoute()); window.scrollTo(0, 0); };
		addEventListener("hashchange", update);
		return () => removeEventListener("hashchange", update);
	}, []);
	const go = (path: string) => { location.hash = `/${path}`; };
	const alertCount = alerts.data?.length ?? 0;
	const tabButton = (t: (typeof TABS)[number], phone: boolean) => {
		const on = route.tab === t.id;
		return (
			<a key={t.id} href={`#/${t.id}`} aria-current={on ? "page" : undefined}
				className={phone
					? `relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${on ? "font-medium text-primary" : "text-muted"}`
					: `relative flex items-center gap-2 rounded-md px-3 py-2 text-sm ${on ? "bg-soft font-medium text-primary" : "text-muted hover:text-ink"}`}>
				<Icon name={t.icon} size={phone ? 22 : 18} />
				{t.label}
				{t.id === "more" && alertCount > 0 && <span className={`absolute grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] text-bg ${phone ? "top-1 left-1/2 ml-2" : "-top-1 -right-1"}`} aria-label={`${alertCount} alerts`}>{alertCount}</span>}
			</a>
		);
	};
	return (
		<>
			<header className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur">
				<div className="mx-auto flex h-16 max-w-[1240px] items-center gap-6 px-6 max-sm:px-4">
					<a href="#/home" className="flex items-center gap-2 text-lg font-bold"><span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-on-primary"><Icon name="Wallet" size={18} /></span>Akahu</a>
					<nav className="flex gap-1 max-sm:hidden" aria-label="Pages">{TABS.map((t) => tabButton(t, false))}</nav>
					<div className="ml-auto">{(route.tab === "home" || route.tab === "more") && <MonthPicker month={month} onMonth={setMonth} />}</div>
				</div>
			</header>
			<main className="mx-auto max-w-[1240px] px-6 pt-6 max-sm:px-4 max-sm:pb-20">
				{route.tab === "home" && <Home month={month} onMonth={setMonth} go={go} />}
				{route.tab === "transactions" && <Transactions view={route.view} go={go} />}
				{route.tab === "accounts" && <Accounts />}
				{route.tab === "more" && <More month={month} theme={theme} onTheme={setTheme} />}
				{route.tab === "home" && <footer className="py-6 text-xs text-muted">Your Akahu data, synced by your banks about once a day. Transfers between your own accounts and saving are not spending, as on the phone.</footer>}
			</main>
			<nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-bg sm:hidden" aria-label="Pages">{TABS.map((t) => tabButton(t, true))}</nav>
		</>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
