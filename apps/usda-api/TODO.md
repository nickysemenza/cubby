# USDA API TODO

## Decide whether edge FTS should include brand fields

The old SQLite FTS indexed `description`, `short_description`, `brand_name`, and
`brand_owner`. The current D1/R2 edge artifact indexes only `description`.

This is simpler and matches the initial migration plan, but it means products
whose brand appears only in `brand_name` or `brand_owner` may no longer be
findable by brand search.

Decision needed before the next full rebuild:

- Keep description-only FTS if Cubby search should be food-name focused.
- Add `short_description`, `brand_name`, and `brand_owner` to the D1 FTS table if
  brand search parity with the old SQLite runtime matters.
