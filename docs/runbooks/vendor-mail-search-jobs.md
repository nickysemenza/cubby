# Vendor Gmail search runs

A vendor Gmail search is one `Run` with `purpose = 'mail_search'`. It has no
table of its own: the request lives in `Run.input` and the page-by-page walk in
`Run.progress`, both jsonb validated by `mailSearchRunInput` and
`mailSearchRunProgress` in `packages/schemas/src/run-fields.ts`. The code is
`server/purchase-import/gmail/search-job.ts`.

The 2026-09 consolidation migration (`0002_cleanup`) folded the former
`VendorMailSearchJob` table into these columns, so no expand step applies to
Gmail search state any more; the schema change ships as a committed migration
like every other ([domain rules](../agents/domain-rules.md#production-changes)).

## Shape

- `Run.input`: `after` (the search window) and `searchTerms` (the exact
  sender and domain terms saved at launch). A run created before the terms were
  recorded has an empty list, so its original query cannot be reconstructed.
- `Run.progress`: `phase` (`queued` between pages, `running` while one is
  scanned, then `completed` or `failed`), `pageToken` (the cursor the walk
  started from, null at the newest page), `nextPageToken`, `pagesScanned`,
  `searched`, `reviewable`, and a transient `error` kept while a rate-limited
  page waits to be retried. `skipped` is the Run's own counter.
- `Run.status` stays `running` until the last page or a terminal failure;
  `progress.phase` is the claim state a page's worker compare-and-sets on.

## Inspect a search

```sql
SELECT r."shortcode", r."status", r."input", r."progress", r."startedAt"
FROM "Run" r
WHERE r."purpose" = 'mail_search'
ORDER BY r."startedAt" DESC
LIMIT 20;
```

A `mail_search` Run whose `progress` is NULL never wrote its opening state (its
transaction failed after the Run committed); it is not a search and the code
ignores it.
