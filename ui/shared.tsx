import { createElement, type ReactNode } from "react";
import { createAppClient } from "apps/client";
import { ICONS, type IconName } from "./icon-data.js";

// Every read and write goes through the app's own tools as the signed-in member.
export const client = createAppClient();

export type Result<T> = { data: T | undefined; pending: boolean; error?: string };

export const nzToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date());
export const nzDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date(iso));
// NZ midnight at the start of a day, as epoch ms (NZ is UTC+13 in summer, +12 in winter).
export const nzMidnight = (day: string) => [13, 12].map((h) => Date.parse(`${day}T00:00:00Z`) - h * 36e5).find((t) => nzDay(new Date(t).toISOString()) === day)!;
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const utc = (iso: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-NZ", { ...options, timeZone: "UTC" }).format(new Date(iso));
export const monthLabel = (month: string, style: "long" | "short" = "long") => utc(`${month}-01T00:00:00Z`, { month: style, ...(style === "long" && { year: "numeric" }) });
export const dayLabel = (day: string) => utc(`${day}T00:00:00Z`, { day: "numeric", month: "short" });
export const weekdayLabel = (day: string) => utc(`${day}T00:00:00Z`, { weekday: "short", day: "numeric", month: "short" });

// An unknown currency (an account without a balance, or before accounts load) shows the bare
// number rather than passing it off as NZD.
export const money = (n: number, currency: string | undefined, digits = 2) =>
	new Intl.NumberFormat("en-NZ", { ...(currency && { style: "currency", currency, currencyDisplay: "narrowSymbol" }), minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
// Money in shows a plus, money out a minus, as on the phone.
export const signed = (n: number, currency: string | undefined) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(Math.abs(n), currency)}`;
export const compact = (n: number, currency: string) =>
	new Intl.NumberFormat("en-NZ", { style: "currency", currency, currencyDisplay: "narrowSymbol", notation: "compact", maximumFractionDigits: 1 }).format(n);

export const FLOW_LABELS: Record<string, string> = { spending: "Spending", income: "Income", transfer: "Transfer", saving: "Saving", excluded: "Excluded" };
export const FLOW_TEXT: Record<string, string> = { spending: "text-spending", income: "text-income", transfer: "text-transfer", saving: "text-saving", excluded: "text-muted" };
export const FLOW_BG: Record<string, string> = { spending: "bg-spending", income: "bg-income", transfer: "bg-transfer", saving: "bg-saving", excluded: "bg-muted" };

export function Icon({ name, size = 20, className = "" }: { name: IconName; size?: number; className?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
			{ICONS[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
		</svg>
	);
}

// A round, flow-tinted icon, as in the mobile app's transaction rows.
export function FlowIcon({ name, flow, size = 36 }: { name: IconName; flow: string; size?: number }) {
	return (
		<span className={`relative grid shrink-0 place-items-center rounded-full ${FLOW_TEXT[flow] ?? "text-ink"}`} style={{ width: size, height: size }}>
			<span className={`absolute inset-0 rounded-full opacity-12 ${FLOW_BG[flow] ?? "bg-ink"}`} />
			<Icon name={name} size={Math.round(size * 0.5)} className="relative" />
		</span>
	);
}

export function FlowPill({ flow }: { flow: string }) {
	return (
		<span className={`relative inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${FLOW_TEXT[flow] ?? ""}`}>
			<span className={`absolute inset-0 rounded-full opacity-12 ${FLOW_BG[flow] ?? "bg-ink"}`} />
			<span className="relative">{FLOW_LABELS[flow] ?? flow}</span>
		</span>
	);
}

export function Card({ title, aside, children, className = "" }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={`rounded-lg border border-line p-5 max-sm:p-4 ${className}`}>
			{title && (
				<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
					<h2 className="text-lg font-semibold">{title}</h2>
					{aside}
				</div>
			)}
			{children}
		</section>
	);
}

// A failed or slow read stays inside its own section; the rest of the page keeps working.
export function Loaded<T>({ result, children, height = "h-24" }: { result: Result<T>; children: (data: T) => ReactNode; height?: string }) {
	if (result.data !== undefined) {
		return (
			<>
				{result.error && <p className="mb-2 text-xs text-danger" role="alert">Showing earlier data: {result.error}</p>}
				{children(result.data)}
			</>
		);
	}
	if (result.error) return <p className="py-4 text-sm text-danger" role="alert">Couldn't load this from Akahu: {result.error}</p>;
	return <div className={`${height} animate-pulse rounded-lg bg-soft`} aria-label="Loading" />;
}

export function Sparkline({ points, className = "h-10 w-full" }: { points: number[]; className?: string }) {
	if (points.length < 2) return <div className={`flex items-center ${className}`} title="The chart starts once the daily check has run on two days"><div className="w-full border-t-2 border-dashed border-line" /></div>;
	const W = 200, H = 40, lo = Math.min(...points), hi = Math.max(...points), span = hi - lo || 1;
	const path = points.map((v, i) => `${i ? "L" : "M"}${(i / (points.length - 1)) * W},${H - 4 - ((v - lo) / span) * (H - 8)}`).join(" ");
	return (
		<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className} aria-hidden="true">
			<path d={`${path} L${W},${H} L0,${H} Z`} fill="var(--primary)" opacity="0.08" />
			<path d={path} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

export const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
