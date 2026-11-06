---
name: monthly-checkin
description: Runs a monthly money check-in from NZ bank data - cash flow, budgets, recurring payments and unusual debits - with evidence. Use when asked for a monthly review, how the month went, end-of-month summary, or a budget check through the Akahu Executor app.
---

# Monthly check-in

A short, evidence-backed review of one NZ calendar month and the month before it.

## Steps

1. Find this app's tools through Executor search; the installed app slug can differ.
2. Check freshness first with `accounts.freshness`. Report any warnings
   (INACTIVE accounts, stale or never-synced transactions) before any number,
   and say the totals exclude what Akahu has not synced.
3. `insights.cashflow` with `months: 2` gives last month and the current, partial
   month. For a finished month the user names, use enough months to include it.
   Compare like with like: a partial month is not comparable to a full one.
4. `insights.budgetStatus` for the month. Compare `percent_used` with
   `month_elapsed_percent` to say whether each budget is on pace. If the user has
   no budgets, show `unbudgeted` spending by group and offer to set some
   (`memory.setBudget`); do not set them unasked.
5. `insights.largeOrUnusual` for the month's dates, so you can mention large or new
   payments with their ids.
6. Optionally `insights.recurring` to mention renewals due before the month ends
   (`next_expected`).
7. `monitor.alerts` for alerts the user has not seen yet, and
   `monitor.balanceHistory` to show how balances moved over the month (history
   starts when the daily check first ran).

## Report

- Lead with net cash flow per currency, then income and outgoings. Never add
  currencies together.
- Then budgets that are over or ahead of pace, then unusual debits, then upcoming
  regular payments.
- Say how many rows were left out as transfers between the user's own accounts or by
  their rules (`transfers_left_out`, `excluded_by_rules`, `rules_applied`), so the
  user can check that nothing real was hidden.
- Dates are NZ calendar dates. Amounts are negative for money out.
- Keep it short: a few lines per section, with evidence ids for claims about
  specific payments.

## Remember

Offer, never assume: tagging a payment (`memory.tag`), a note (`memory.setNote`), a
rule for a transfer the pairing missed (`memory.addRule`), or a budget change.
