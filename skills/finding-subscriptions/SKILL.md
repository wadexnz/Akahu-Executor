---
name: finding-subscriptions
description: Finds subscriptions, bills and other regular payments in NZ bank history and what they cost per month. Use when asked about subscriptions, recurring charges, bills, what to cancel, or upcoming debits through the Akahu Executor app.
---

# Finding subscriptions

Find regular payments with evidence, and let the user decide what they mean.

## Query

1. Find this app's `insights.recurring`, `insights.merchantHistory` and
   `transactions.getMany` tools through Executor search; the installed app slug can differ.
2. Call `insights.recurring` with no arguments for the last 13 months, or with
   `account_id` when the user names an account. A yearly charge needs at least
   `min_occurrences` payments in the window, so for annual renewals say that
   13 months shows at most two: lower `min_occurrences` to 2 and `months` to 24.
3. Read `rules_applied` and say if the user's rules left anything out.

## Report

- Group active payments by cadence and lead with `totals`: the monthly
  equivalent per currency. Never add currencies together.
- For each payment give the payee, typical amount, cadence and `next_expected`.
  Mention `amount_varies` (a price change or a usage-based bill) and show the
  range from `min_amount` to `max_amount`.
- List `lapsed` payments separately: they stopped, or the card or account changed.
- Quote `evidence_ids` for any payment the user asks about; `transactions.getMany`
  fetches them. Use `insights.merchantHistory` to check a price rise.
- Say what the method can miss: payments with a different description each time,
  payments shared across several accounts on alternating schedules, payments
  younger than three cycles, and anything older than Akahu's history (see the
  `akahu-data-limits` skill).

## Acting on it

- Do not call a payment unnecessary; the user decides. Offer to tag the ones they
  want to review (`memory.tag`, for example `to cancel`) or note why one exists
  (`memory.setNote`).
- Akahu cannot cancel anything. Point the user to the provider or their bank.
- A regular transfer to the user's own savings is not a subscription. If one
  appears, offer a `transfer` rule (`memory.addRule`) after the user agrees.
