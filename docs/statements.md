# Bank statements

Choose the destination account before previewing a CSV, OFX or QFX file. Import
adds cleared transactions with no category or income assignment. Assign those in
the register after import. Statement balances never create adjustments.

CSV supports comma, tab and semicolon delimiters, quoted fields and multiline
memos, UTF-8 with an optional BOM, and up to 19 metadata rows before the header.
Use Date plus Amount, or Date plus Debit and Credit. Payee/Description/Merchant,
Memo/Notes, and FITID/Transaction ID/Reference are optional. Equivalent duplicate
headers and simultaneous amount/debit/credit layouts are rejected. Dates use
YYYY-MM-DD or US MM/DD/YYYY. Amounts use a decimal dot; comma grouping, dollars,
and parentheses for negatives are accepted. Debit and credit columns must be
nonnegative with at most one nonzero value. No binary floating point conversion
or amount rounding occurs.

OFX supports XML and legacy SGML scalar end-tag omission, including QFX files.
Bank and credit-card statements must contain exactly one account. Posting dates
retain the bank's written calendar date regardless of the timestamp offset.
UTF-8 and legacy files explicitly declaring Windows-1252 are supported. Currency
mismatches, correction records, external entities, DTDs, malformed structures and
ambiguous scalar fields block import. Investment transactions are unsupported.

Files are limited to 4 MB and 2,000 rows. Oversized records, excessive XML nesting
and excessive element counts are rejected before import. Parsing occurs only in
main and does not fetch URLs or execute content.

Bank IDs deduplicate within the selected account. Conflicting amounts for the
same bank ID block import. Distinct bank IDs and repeated same-day purchases
remain separate. Exact-file reimports are detected by account-scoped provenance.
Without bank IDs, overlapping statements cannot be identified with certainty.
Equal amounts within seven days of existing entries with no bank ID are flagged
for explicit review. Choose import separately, skip, or match an uncleared entry.
Matching preserves its date, payee, memo, categories and splits, marks it cleared,
and attaches the bank ID. The source row and decision remain in provenance. Two
rows cannot match the same entry. Cleared/reconciled lookalikes cannot be matched.

`previewStatement(bytes, filename, budget, accountId, token)` returns a deeply
frozen candidate. Keep it in main and expose only `candidate.preview`. Uncertain
rows accept exactly one token in `approvedRows`: `row.id` adds separately,
`row.skipApprovalId` skips, or `row.matches[n].approvalId` matches. New rows are
included automatically and duplicates are skipped. Cancel by discarding the
candidate. A changed budget requires a fresh preview.

`applyStatement(candidate, budget, approvedRows)` returns a validated budget at
the original revision. Persist its transaction/payee/provenance differences as
one ordinary command with a captured expected revision, so undo, command receipts,
local saves and checkpoints apply. Never activate statements as replacement
budgets. Reapplying recorded provenance is a no-op.

Synthetic verification: `npx vitest run tests/statement.test.ts`. Parser behavior
follows [CSV Parse options](https://csv.js.org/parse/options/) and the
[OFX Banking specification](https://www.financialdataexchange.org/common/Uploaded%20files/OFX%20files/OFX%20Banking%20Specification%20v2.3.pdf).
