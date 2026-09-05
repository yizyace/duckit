---
name: duckit-budgeting
description: Change or review Duckit's Classic budgeting calculations, including exact money, income timing, allocations, carryover, transfers, and historical balances.
---

# Duckit Classic budgeting

Use bigint for arithmetic and lossless string parsing. Never round binary floats
into money. Account balances include transactions dated through the report cutoff;
category activity includes on-budget categorized splits. Transfers between budget
accounts do not create income or spending. Off-budget transfers need explicit
category/income treatment. Credit accounts preserve Classic debt categories.

Income assigned to next month is not available this month. Allocations can be
negative and can exist in future months. Overspending choice is sparse: null or
missing inherits the preceding choice, initially `AffectsBuffer`. `Confined` carries
a negative category balance; `AffectsBuffer` charges next month's available budget.
Historical edits must recompute every affected subsequent month.

Preserve ordered posted and scheduled splits. A transfer may occupy a whole
transaction or one split of a mixed transaction. Update paired legs without
replacing stable counterpart IDs or moving unrelated expenses; retain counterpart
cleared/bank/legacy metadata. See the
[domain boundaries](../../../docs/architecture.md#data-and-process-boundaries) before
changing representation or persistence.

The pure engine lives in [money](../../../src/engine/money.ts),
[calendar](../../../src/engine/calendar.ts), [calculator](../../../src/engine/calculator.ts),
and [transfer logic](../../../src/engine/transfers.ts). Domain mutation and invariant
checks live in [changes](../../../src/engine/changes.ts) and
[validation](../../../src/engine/validation.ts). Preserve the decimal-string and
calendar-date boundaries in [shared contracts](../../../src/shared/contracts.ts).

Use [engine tests](../../../tests/engine.test.ts) for hand-calculated regression
scenarios. The [QA skill](../duckit-qa/SKILL.md) describes broader verification;
legacy reconstruction and independent migration comparison belong to the
[recovery skill](../duckit-recovery/SKILL.md).
