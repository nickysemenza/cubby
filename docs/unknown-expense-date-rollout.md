# Unknown expense dates

`Expense.date = NULL` means the event date is unknown. Only an exactly-zero
`Expense.cost` permits it. No existing dates are changed.

One release owner runs these stages. Do not use a broad `db:push`: it would
remove the existing `NOT NULL` write gate before old readers are replaced, and
does not install CHECK constraints.

## 1. Install the constraint; retain the write gate

Before deployment, verify the current schema and apply this additive constraint
once. If it already exists, inspect its definition instead of recreating it.

```sql
ALTER TABLE "Expense"
  ADD CONSTRAINT "Expense_date_cost_check"
  CHECK (date IS NOT NULL OR (cost IS NOT NULL AND cost = 0));
```

Keep the existing `date NOT NULL` constraint until the next stage. Old writers
remain compatible; premature requests to clear dates fail without changing data.

## 2. Deploy compatible readers

Deploy the web/API changes and distribute the regenerated Apple client before
allowing null writes. Verify that the clients in use can decode null expense
dates and null timeline-group dates. Existing installed native clients with
required date properties must be updated first. Existing browser sessions must
reload the new application before using the feature.

The new UI can be deployed while the column is still required. Unknown-date
writes remain unavailable until stage 3; do not declare the feature enabled yet.

## 3. Enable unknown dates and verify

After the compatible readers are in use:

```sql
ALTER TABLE "Expense" ALTER COLUMN date DROP NOT NULL;

SELECT attnotnull
FROM pg_attribute
WHERE attrelid = '"Expense"'::regclass AND attname = 'date';

SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = '"Expense"'::regclass
  AND conname = 'Expense_date_cost_check';
```

The column must report `attnotnull = false` and the CHECK must require a known
zero cost when the date is null. Verify a $0 unknown-date write through the
deployed application, its undated history, and refusal of a cost-only change
to a nonzero value. Use synthetic records for verification and keep real data
out of logs and engineering artifacts.

After null dates have been written, do not roll back to clients that require
dates or restore `NOT NULL` by inventing event dates. Retain nullable readers
and the cost/date CHECK while repairing a release.
