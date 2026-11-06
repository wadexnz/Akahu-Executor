# A spending review with incomplete data

This is a synthetic, reproducible worked example, not a real customer's data or
a recording of a model conversation. The final explanation below is authored;
the tool result is produced by the real app through Executor's local host handler.

From the repository root, after installing dependencies:

```sh
bun run demo
```

No Executor login, Akahu keys, network requests or LLM are needed. `demo.ts`
replaces HTTP responses with invented fixtures and simulates the user's form
answer. It prints the prompt, actual form, scripted answer and actual tool result.
It does not verify a hosted MCP client's form rendering or pause/resume transport.

## Prompt and choices

> Review my spending. Ask me which accounts and periods to compare.

The agent discovers `insights.reviewSpending` and calls it with `{}`. The tool offers
Everyday and Reserve, the two eligible NZD accounts. USD, unknown-currency and
no-feed accounts are not offered. The demo's scripted user selects both and enters:

```json
{
  "account_ids": ["acc_everyday", "acc_reserve"],
  "baseline_start": "2026-01-01T00:00:00+13:00",
  "baseline_end": "2026-01-31T23:59:59.999+13:00",
  "comparison_start": "2026-02-01T00:00:00+13:00",
  "comparison_end": "2026-02-28T23:59:59.999+13:00"
}
```

These are inclusive NZ summer boundaries. If the caller supplies the equivalent
`account_ids`, `baseline` and `comparison` arguments directly, no form is needed.

## Result and independent arithmetic

The tool returns `status: completed`, but report `coverage: partial`: Reserve
has a January debit of $999 and fails to load February. It is excluded from
**both** periods. Treating that failure as zero would manufacture a decline.

Everyday's synthetic settled debits are:

| Period | Evidence | Category | NZD debit magnitude |
| --- | --- | --- | ---: |
| January | `trans_jan1`, `trans_jan2`, `trans_jan3` | Groceries | $20 + $30 + $50 = $100 |
| February | `trans_feb1` | Groceries | $80 |
| February | `trans_feb2` | Dining | $40 |
| February | `trans_feb3` | Transfers | $150 |

January totals $100; February totals $270; the difference is +$170. Category
changes are groceries −$20, dining +$40 and transfers +$150. Dining and transfers
have a null percentage change because their baseline is zero.

The baseline debit median is $30. The unusual-debit threshold is the larger of
$100 and 3 × $30, therefore $100. Only `trans_feb3` meets it. This is deliberately
a transfer: an amount flag must not become an unsupported fraud or spending claim.

## Example explanation

> **Partial review: Everyday only, NZD.** You selected Everyday and Reserve for
> January versus February 2026. Reserve's February query failed, so neither
> period includes Reserve. Freshness timestamps were not supplied by the fixture.
>
> Everyday's cached settled debits increased from **$100 to $270 (+$170)**.
> The largest change is a **$150 transfer** (`trans_feb3`), not necessarily
> consumption. Groceries fell $20 (`trans_jan1`–`trans_jan3`, `trans_feb1`),
> while dining added $40 (`trans_feb2`).
>
> The transfer also exceeds the $100 amount threshold. This is an amount-based
> flag, not evidence of fraud. January and February have different lengths,
> and the totals are not normalised. Cached history may be incomplete; pending
> transactions, credits/refunds and mobile classification rules are not included
> in these debit totals. This cannot establish a whole-account spending trend.
>
> Would you like to inspect the transfer before interpreting the increase?

The regression tests execute this fixture through the public host boundary and
check totals, evidence IDs, exclusions and flags independently. They also cover
cancellation, partial input, unavailable forms, invalid scope and currency restrictions.
