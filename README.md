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

| Tool | Purpose |
| --- | --- |
| `accounts.list` | Connected accounts and balances |
| `transactions.search`, `transactions.get` | Settled transactions |
| `transactions.pending` | Pending transactions |
| `transactions.summary` | Totals by category, merchant or type |
| `insights.compare` | Compare two periods (see below) |
| `insights.reviewSpending` | Guided comparison: ask for missing accounts or periods, then return the same evidence-backed report |
| `identity.me` | The connected Akahu user |
| `admin.refresh` | Ask Akahu to refresh; needs approval on every call |

All tools except `admin.refresh` are read-only, and none can make payments.
Each tool declares MCP annotations and an output schema. Category and
connection listings are not available because they need an Akahu app secret,
which Personal Apps do not have.

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
