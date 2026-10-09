# ADR 0008: Serve each USDA release from a SQLite Durable Object

Status: Accepted.

## Context

USDA food data was served by a separate `usda-api` Worker: a D1 index plus FTS5
table pointed at byte ranges in R2 NDJSON bundles, with a D1 `food_cache`, a
Cache API layer, and a web-side batch lookup cache stacked on top to hide the
latency. A lookup cost several sequential D1 round trips (about 60 ms each)
plus the web → `usda-api` service-binding hop, and every real client already
reached USDA through the web worker.

A USDA release is immutable and read-only, so it needs no database server. In a
FoodData Central release, most branded rows are superseded food revisions: the
2026-04 release has 1,999,950 branded rows for 465,110 distinct UPCs.

## Decision

- Each USDA release is one SQLite-backed Durable Object hosted by the web
  worker and called over typed RPC. The query logic lives in `packages/usda`;
  the separate `usda-api` Worker, its HTTP/OpenAPI surface, D1 database, and
  every USDA cache layer are deleted.
- The DO is named by the release plus a schema generation (`2026-04.g1`), and
  the active name is a deploy var. A schema change bumps the generation and
  reloads the release from its R2 shards; there is no in-place migrator for
  release data. Activation and rollback are a deploy.
- A release loads itself: the DO pulls gzipped `FoodSummary` NDJSON shards from
  R2 in an alarm loop and reports its progress until ready.
- Only the current revision of each branded food is stored. An alias table
  maps every older revision's `fdc_id` to it, and each activation advances
  `Product.fdc_id` links to current revisions automatically, with no triage.

## Considered options

- **D1 read replication with Sessions**: shortens each round trip but keeps
  their number and the cache stack.
- **Workers KV**: fast immutable point lookups, but cannot search.
- **Basin (formerly R2 SQL)**: analytical scans over Iceberg tables, billed per
  byte scanned; wrong shape for typeahead and barcode lookups.
- **External search or Postgres hosts**: add the network hop this removes.
- **Keeping every branded revision**: four times the rows, duplicate results to
  dedupe in every client, and a stale stored id with each new release.

## Consequences

- A web deploy restarts the release DO; its first queries read from a cold page
  cache.
- Search results, `/counts`, and the Apple client contract changed shape in
  place.
