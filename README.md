# Akahu Executor

A hosted [Executor](https://executor.sh) app that gives any agent connected to
your Executor MCP endpoint access to your Akahu data as `tools.akahu.*`.
Originally part of NZ Account Thread.

The deployed identifier remains `akahu` to preserve existing agent connections.

## Credentials

The app declares an `Akahu Personal App` provider with **App ID Token** first,
then **User Access Token**, matching Akahu's setup page and the mobile app.
Connect it from the app's **Accounts** tab in Executor. Upgrading from the old
`app_token` / `user_token` fields requires reconnecting once; mobile's saved
credentials are unchanged.
Executor stores the tokens and only adds them to HTTPS requests to
`api.akahu.io`; app code never sees them.

## Tools

| Tool | Purpose | Approval |
| --- | --- | --- |
| `accounts.list` | Connected accounts and balances (cached 5 min) | |
| `accounts.get` | One account, live | |
| `accounts.freshness` | Sync ages per account, with warnings for INACTIVE, never-synced or stale data | |
| `transactions.search`, `transactions.get` | Settled transactions | |
| `transactions.getMany` | Up to 100 transactions by id, reporting ids Akahu no longer has | |
| `transactions.pending` | Pending transactions, for all accounts or one | |
| `transactions.summary` | Totals by category, personal-finance group, merchant or type | |
| `categories.list` | The bundled NZFCC categories and groups | |
| `insights.compare` | Compare two periods (see below) | |
| `insights.reviewSpending` | Guided comparison: ask for missing accounts or periods, then return the same evidence-backed report | |
| `identity.me` | The connected Akahu user | |
| `identity.parties` | Identity data the banks hold; only the requested fields | Every call |
| `identity.verifyName` | Check a name against holder and party names | Every call |
| `admin.refresh` | Ask Akahu to refresh | Every call |
| `admin.reportEnrichmentIssue` | Report a wrong merchant/category or a duplicate to Akahu | Every call |

Only the two `admin` tools change anything at Akahu, and none can make payments
(Personal Apps cannot). Each tool declares MCP annotations and an output schema.
An approval covers the exact arguments shown, so approving a name-only
`identity.parties` call does not approve reading the IRD number.

Akahu's category and connection listings need an app secret, which Personal Apps
do not have. The app bundles the public [NZFCC](https://nzfcc.org) category list
instead (`categories.ts`); `search` and `summary` accept a personal-finance
`group` such as `Food` or `Transport`.

## Identity data

`identity.parties` returns only the fields you ask for (`name` by default; also
`dob`, `tax_number` (IRD number), `email_addresses`, `phone_numbers` and
`addresses`). Other fields that exist are listed in `withheld_fields`, never
returned. `identity.verifyName` reports which name parts matched and where, but
does not repeat the bank's version of the name. Both pass data through Executor
and your agent's model provider, so ask for identity data only when a task needs it.

## Currency totals

`transactions.search` returns `currencies: [{ currency, net_total }]` for the rows
actually returned, not the full history when `truncated` is true.
`transactions.summary` returns a `currencies` array containing each currency's
transaction count, signed debit/credit totals and category/merchant/type groups.
There is no combined total or FX conversion. These replace the previous
top-level `net_total`, `total_spending`, `total_income` and `groups` fields.

Both tools look up each account's balance currency. Rows with missing currency
metadata are counted and listed in `unknown_currency_transaction_ids`, but are
excluded from monetary totals; `transactions.search` still returns those rows.
Failure to fetch account metadata fails the call rather than guessing a unit.
An original purchase's `fx` currency does not replace the account currency.
Debit totals include transfers; these tools do not apply the mobile app's rules.

## Date ranges

Every tool treats `start` and `end` as inclusive. Akahu's own `start` is
exclusive, so the app requests one millisecond earlier; otherwise transactions
dated exactly at the start (often midnight, since many banks only supply a
date) would be dropped.

## Freshness, caching and rate limits

- Account lists are cached for 5 minutes and settled transaction pages for 15,
  per connected Akahu account, using Executor's app cache. Pending transactions,
  single or batch lookups, `accounts.get` and identity data are always fetched live.
- `admin.refresh` starts a new cache generation, so nothing cached before the
  refresh request is served afterwards. Akahu still needs time to sync the bank.
- Reads that Akahu rate-limits (429) are retried up to three times with jittered
  exponential backoff, or after `Retry-After` (capped at 10 seconds). A
  rate-limited refresh is reported, not retried.
- Akahu failures surface as Executor `ProviderError`s: 401 `unauthorized`
  (revoked or rotated token), 403 `rejected` (app ID, permissions or IP
  allow-list), 429 `rate_limited` and 5xx `unavailable`. Response bodies are
  never passed on.
- If the cache is unavailable (as in the local test host), tools read Akahu
  directly instead of failing.

## Comparing two periods

`insights.compare` takes explicit account IDs and two non-overlapping
periods with full ISO timestamps (including the Pacific/Auckland offset):

```json
{
  "account_ids": ["acc_example"],
  "baseline": { "start": "2026-01-01T00:00:00+13:00", "end": "2026-01-31T23:59:59.999+13:00" },
  "comparison": { "start": "2026-02-01T00:00:00+13:00", "end": "2026-02-28T23:59:59.999+13:00" }
}
```

- Only NZD accounts with a transaction feed are queried; anything excluded is
  listed with a reason. An account that fails to load is excluded from both
  periods, so a failure is never counted as zero spending.
- It compares settled debits (transfers included) by category and merchant,
  with the transaction IDs behind each change. Pending transactions are excluded
  and totals are not adjusted for different period lengths.
- Comparison debits of at least NZD 100 and three times the baseline median are
  flagged as unusual. This is a simple amount heuristic, not fraud detection.

Transaction text comes from third parties. Agents are told to treat it as data,
but that is guidance, not a security boundary.

## Guided spending review

Ask your agent: **“Review my spending. Ask me which accounts and periods to compare.”**

`insights.reviewSpending` accepts the same `account_ids`, `baseline` and `comparison`
arguments as `insights.compare`, but each may be omitted. It asks for
missing choices through Executor's form elicitation; supplied choices remain
unchanged. Nothing is preselected, and only NZD accounts with a transaction feed
are offered. Dates use inclusive ISO timestamps with explicit offsets. If an
interval is supplied, both `start` and `end` are required. Invalid or overlapping
intervals fail rather than being silently corrected.

- `completed` returns a `report` with the comparison's evidence and limitations.
  Check its `coverage`: completion does not imply complete or available history.
- `cancelled` and `declined` return no report and read no transactions. Account
  metadata may already have been read to populate the choices.
- Without form support, ask the user in chat and pass all three arguments;
  fully specified calls require no elicitation. Missing inputs without form
  support fail; there is no fallback to all accounts or guessed periods.

Executor delivers forms through its model, native-client or browser mode. The
native mode requires a compatible MCP client. This app does not own that UI.
The workflow neither refreshes bank data nor stores reports in an app database;
tool results still pass through Executor and the connected agent/model provider.

The packaged [`reviewing-spending` skill](skills/reviewing-spending/SKILL.md)
explains scope, evidence, coverage, transfer caveats and privacy. After deploying,
read it with Executor's `skills` tool using the installed app slug and
`name: "reviewing-spending"`. The `skills/` directory must be included in the
deployment alongside the source; the framework discovers it automatically.

### Try the synthetic agent example

```sh
bun run demo
```

This executes the real tool through Executor's local host boundary with invented
API responses and a scripted form answer, without network access or credentials.
Read the [worked explanation](skills/reviewing-spending/references/demo.md): a
failed account is excluded from both periods, and an unusual debit turns out to
be a transfer. The automated tests exercise the same fixture. This is not a live
MCP session or proof that a particular client renders the form correctly.

## Layout

| File | Contents |
| --- | --- |
| `index.ts` | `defineApp`: requirements, icon and the root router |
| `icon.ts` | The app icon |
| `provider.ts` | The `Akahu Personal App` provider and its health check |
| `client.ts` | HTTP helpers, retries, error mapping, caching and transaction paging |
| `schemas.ts` | Akahu response decoders and agent-facing output shapes |
| `compare.ts` | Pure period-comparison logic |
| `categories.ts` | Bundled NZFCC categories (regenerate from nzfcc.org when they change) |
| `tools/*.ts` | One router per group (`accounts`, `transactions`, `categories`, `insights`, `identity`, `admin`) |

## Develop and deploy

```sh
npm install --no-package-lock
bun run typecheck
bun test          # uses a synthetic Akahu API, no real data

```

To deploy to your own Executor account:

```sh
npm i -g executor@beta
executor apps login --host https://api.executor.sh

# First time: create the app and note the id it prints (app_…)
executor apps create --host https://api.executor.sh --name akahu --files .

# Deploy (after creating, and after each change)
bun run deploy --app <your-app-id>
```

Then open the app in Executor, connect your Akahu tokens under **Accounts**, and
connect your agents to your Executor MCP endpoint.

`package.json` pins the `apps` framework version that the hosted Executor runs
(`executor apps framework`). Do not upgrade it to the unrelated `apps@latest`.
