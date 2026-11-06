import { useState } from "react";
import { queryReference } from "apps/client";
import { useAppQuery } from "apps/react";
import type { accountFreshness } from "../tools/accounts.js";
import type { investmentContributions } from "../tools/insights.js";
import type { balanceHistory } from "../tools/monitor.js";
import { BalanceHistoryOut, ContributionsOut, FreshnessOut } from "../schemas.js";
import { netWorthAtom } from "./home.js";
import { Card, client, dayLabel, Icon, Loaded, money, Sparkline } from "./shared.js";
import { accountLabel, accountsAtom } from "./transactions.js";

const historyAtom = client.queryAtom(queryReference<typeof balanceHistory>("monitor.balanceHistory"), { days: 90 }, BalanceHistoryOut);
const freshnessAtom = client.queryAtom(queryReference<typeof accountFreshness>("accounts.freshness"), {}, FreshnessOut);
const contributionsAtom = client.queryAtom(queryReference<typeof investmentContributions>("insights.investmentContributions"), {}, ContributionsOut);

const TYPE_LABELS: Record<string, string> = {
	CHECKING: "Everyday", SAVINGS: "Savings", CREDITCARD: "Credit card", LOAN: "Loan", KIWISAVER: "KiwiSaver", INVESTMENT: "Investment",
	TERMDEPOSIT: "Term deposit", FOREIGN: "Foreign currency", TAX: "Tax", REWARDS: "Rewards", WALLET: "Wallet",
};

function NetWorth() {
	const worth = useAppQuery(netWorthAtom);
	const history = useAppQuery(historyAtom);
	return (
		<Loaded result={worth} height="h-36">
			{(data) => data.currencies.length === 0 ? <Card><p className="text-sm text-muted">No balances yet.</p></Card> : (
				<div className="flex flex-col gap-4">
					{data.currencies.map((c) => {
						const days = history.data?.totals.find((t) => t.currency === c.currency)?.days ?? [];
						return (
							<Card key={c.currency} className="grid gap-5 sm:grid-cols-[1.2fr_2fr] sm:items-center">
								<div>
									<div className="font-medium">Net worth{data.currencies.length > 1 ? ` (${c.currency})` : ""}</div>
									<div className="mt-1 text-[40px] leading-tight font-bold tracking-tight max-sm:text-[34px]">{money(c.net, c.currency)}</div>
									<div className="mt-3 grid grid-cols-3 gap-3 text-sm">
										<div><div className="text-muted">Cash</div><div className="font-semibold">{money(c.cash, c.currency)}</div></div>
										<div><div className="text-muted">Other assets</div><div className="font-semibold">{money(c.other_assets, c.currency)}</div></div>
										<div><div className="text-muted">Debt</div><div className={`font-semibold ${c.debt ? "text-spending" : ""}`}>{money(c.debt, c.currency)}</div></div>
									</div>
								</div>
								<div>
									<Sparkline points={days.map((d) => d.current)} className="h-24 w-full" />
									<div className="mt-1 text-xs text-muted">{days.length >= 2 ? `Daily total since ${dayLabel(days[0]!.day)}` : "The chart fills in as the daily check records balances."}</div>
								</div>
							</Card>
						);
					})}
				</div>
			)}
		</Loaded>
	);
}

// Green: synced within a day; amber: a warning; grey: never synced.
function Freshness({ id }: { id: string }) {
	const freshness = useAppQuery(freshnessAtom);
	const f = freshness.data?.accounts.find((a) => a.id === id);
	if (!f) return null;
	const age = f.refreshed.balance?.age_hours;
	const colour = f.warnings.length ? "bg-warning" : age === undefined ? "bg-muted" : "bg-income";
	const text = f.warnings[0] ?? (age === undefined ? "Not synced yet" : age < 1 ? "Synced within the hour" : `Synced ${Math.round(age)}h ago`);
	return <span className="flex items-center gap-1.5 text-xs text-muted" title={f.warnings.join(" ") || text}><i className={`h-2 w-2 rounded-full ${colour}`} />{f.warnings.length ? "Check sync" : text}</span>;
}

function AccountList() {
	const accounts = useAppQuery(accountsAtom);
	const history = useAppQuery(historyAtom);
	return (
		<Loaded result={accounts} height="h-48">
			{(list) => {
				const banks = new Map<string, typeof list>();
				for (const a of list) banks.set(a.bank, [...(banks.get(a.bank) ?? []), a]);
				return (
					<div className="grid gap-4 lg:grid-cols-2">
						{[...banks].map(([bank, rows]) => (
							<Card key={bank} title={bank}>
								<ul className="divide-y divide-line">
									{rows.map((a) => {
										const points = history.data?.accounts.find((h) => h.account_id === a.id)?.snapshots.map((s) => s.current) ?? [];
										const b = a.balance;
										return (
											<li key={a.id} className="grid grid-cols-[1fr_80px_auto] items-center gap-3 py-3 max-sm:grid-cols-[1fr_auto]">
												<div className="min-w-0">
													<div className="truncate font-medium">{accountLabel(a, a.id)}</div>
													<div className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
														<span>{TYPE_LABELS[a.type] ?? a.type}</span>
														{a.status === "INACTIVE" && <span className="text-warning">Not syncing</span>}
														<Freshness id={a.id} />
													</div>
												</div>
												<div className="max-sm:hidden"><Sparkline points={points} className="h-8 w-full" /></div>
												<div className="text-right">
													{b ? <div className={`font-semibold ${b.current < 0 ? "text-spending" : ""}`}>{money(b.current, b.currency)}</div> : <div className="text-sm text-muted">No balance</div>}
													{b && b.available !== b.current && <div className="text-xs text-muted">{money(b.available, b.currency)} available</div>}
												</div>
											</li>
										);
									})}
								</ul>
							</Card>
						))}
					</div>
				);
			}}
		</Loaded>
	);
}

function Contributions() {
	const result = useAppQuery(contributionsAtom);
	const [open, setOpen] = useState(false);
	return (
		<Card title="Investment contributions" aside={<span className="text-sm text-muted">Last 12 months</span>}>
			<Loaded result={result}>
				{(data) => data.providers.length === 0 ? <p className="text-sm text-muted">No payments to investment or KiwiSaver providers found.</p> : (
					<>
						<table className="w-full text-sm">
							<thead className="text-left text-muted">
								<tr><th className="pb-2 font-normal">Provider</th><th className="pb-2 text-right font-normal">Paid in</th><th className="pb-2 text-right font-normal max-sm:hidden">Withdrawn</th><th className="pb-2 text-right font-normal">Net</th></tr>
							</thead>
							<tbody className="divide-y divide-line">
								{(open ? data.providers : data.providers.slice(0, 6)).map((p) => (
									<tr key={`${p.provider}|${p.currency}`}>
										<td className="py-2.5"><div className="font-medium">{p.provider}</div><div className="text-xs text-muted">{p.transaction_count} payment{p.transaction_count === 1 ? "" : "s"} · last {dayLabel(p.last_activity)}</div></td>
										<td className="py-2.5 text-right">{money(p.paid_in, p.currency)}</td>
										<td className="py-2.5 text-right max-sm:hidden">{money(p.withdrawn, p.currency)}</td>
										<td className="py-2.5 text-right font-semibold text-saving">{money(p.net_contributed, p.currency)}</td>
									</tr>
								))}
							</tbody>
						</table>
						{data.providers.length > 6 && <button className="mt-2 text-sm font-medium text-primary" onClick={() => setOpen(!open)}>{open ? "Show fewer" : `Show all ${data.providers.length}`}</button>}
					</>
				)}
			</Loaded>
		</Card>
	);
}

export function Accounts() {
	return (
		<div className="flex flex-col gap-5 pb-8">
			<h1 className="text-3xl font-bold tracking-tight">Accounts</h1>
			<NetWorth />
			<AccountList />
			<Contributions />
			<p className="flex items-center gap-1.5 text-xs text-muted"><Icon name="Info" size={14} />Akahu syncs each bank about once a day. Debt is money owed on credit cards and loans.</p>
		</div>
	);
}
