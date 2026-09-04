# Classic budgeting rules

Use bigint for arithmetic and lossless string parsing. Never round binary floats
into money. Account balances include transactions dated through the report cutoff;
category activity includes on-budget categorized splits. Transfers between budget
accounts do not create income or spending. Off-budget transfers need explicit
category/income treatment. Credit accounts preserve Classic debt categories.

Income assigned to next month is not available this month. Allocations can be
negative and can exist in future months. Overspending choice is sparse: null or
missing inherits the preceding choice, initially AffectsBuffer. Confined carries a
negative category balance; AffectsBuffer charges next month's available budget.
Historical edits must recompute every affected subsequent month.
