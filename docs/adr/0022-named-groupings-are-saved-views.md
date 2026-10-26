# ADR 0022: Named groupings are saved views

Status: Accepted.

## Decision

Named groupings of records are code-declared saved views using category,
family, location, brand, or tag filters. Locations provide physical grouping.

Tag-backed Collections (#834) and smart starters (#986) are removed because
they duplicated saved views and were unused. Product and Location tags remain
plain tags; no database migration is needed. The owner strips the remaining
`collection:*` values separately through a one-off SQL correction.

User-created saved views remain parked in #2374.
