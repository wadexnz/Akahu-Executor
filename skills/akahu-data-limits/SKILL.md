---
name: akahu-data-limits
description: Explains what NZ bank data from an Akahu Personal App can and cannot show - history length, sync timing, pending rows, dates, enrichment and changing ids. Use before relying on totals, when data looks missing or stale, or when the user asks why something is not shown, through the Akahu Executor app.
---

# Akahu data limits

Check these before treating results as complete, and explain them plainly when data
looks wrong.

## History

- A Personal App sees up to two years of transactions, counted back from when the
  app was created (`identity.me` shows `access_granted_at`). Some banks keep less:
  SBS about 6 months, ASB 12 months. An account connected recently may have less.
- Empty results do not prove no activity. Say what range and accounts were queried.

## Sync timing

- Akahu syncs Personal App data about once a day. `accounts.freshness` shows how old
  each account's balance and transactions are and warns when they are stale or
  never synced, or when the account is INACTIVE (it can no longer sync but keeps its
  cached history; the user reconnects it at my.akahu.nz).
- `admin.refresh` asks for a sync, needs the user's approval, and does nothing
  within an hour of the last one. New data can take minutes to appear. Insights
  read settled pages cached for up to 15 minutes, and account lists for 5 minutes.

## Balance history

- Akahu reports only today's balance. `monitor.balanceHistory` shows the app's own
  daily snapshots, which start when `monitor.check` first ran; days the check did
  not run are gaps, not changes.

## Pending and settled

- Pending transactions (`transactions.pending`) have no id, merchant or category,
  can change or vanish, and are never part of insights or totals.

## Dates

- Many banks give only a date, so times are often midnight. The app uses NZ
  calendar days (Pacific/Auckland) for months and cadences. Official open banking
  connections may give the settlement date instead of the purchase date.

## Enrichment

- Merchants and categories are Akahu's best guesses and are missing on many
  transactions, especially money in. `Ungrouped` or `Uncategorised` is common.
  `admin.reportEnrichmentIssue` reports a wrong one to Akahu (with approval).

## Changing ids

- About 0.1% of transaction ids change when a bank edits a transaction, and an
  account moved to official open banking gets new ids for its history.
  `transactions.getMany` lists ids it could not find in `missing_ids`; notes and tags
  saved against an old id stay with that id.

## Currencies

- Amounts are in each account's currency. Totals are per currency and never
  converted. Rows whose account currency is unknown are listed, not counted.

## Payments

- There are no payment or transfer tools: Akahu Personal Apps cannot make payments.
