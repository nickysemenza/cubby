# ADR 0023: Lists are declared over a relation

Status: Accepted.

## Context

Entity lists derived their filters, URL codec, option feeds and SQL predicates
from the entity declaration, but three surfaces hand-wired the same
machinery. The Work queue had a `defineSourceList` declaration, a hand-listed
route search, its own include/exclude SQL and a central routing table that
imported every domain's branches. Suggestions filtered with a `VIEW_FILTERS`
table, thirteen hand-written `*Exclude` params, a `where{}` wire object and
JavaScript matching. Problems was a separate page of lanes, coverage meters
and per-section remediation registries. Each surface spelled "is not", "No
value" and "Me" slightly differently, and the queue's dependency pointed from
the generic engine into every domain.

## Decision

- A list surface is a **Declared list**: its filters, sorts, Group by choices
  and saved views are declared once. Entity lists declare it in the entity
  definition; a list over a SQL relation (the Work queue, each Suggestion
  family) declares a **Relation list** with `defineRelationList`.
- One derivation serves every Declared list: the URL codec (`<col>Exclude`,
  `<col>Presence`, `@me`, No value), the strict input schema, and the
  descriptors `compileDeclaredFilters` compiles into Drizzle predicates over
  any column resolver. A reference filter's options come from the generic
  entity roster.
- The Work queue is a Relation list over a union of **Work sources**. Each
  domain exports `WorkSource` declarations (reasons, Work family, Executor,
  link, actions, candidate query); `server/domains/work` composes them
  explicitly (ADR 0019); the generic engine imports no domain module and owns
  admission pruning, the union, search, filters, sorts, Group by, saved views
  with single-pass counts, paging and hydration.
- Problems is the Work queue's saved view of the `problem` family. Each
  Problems declaration is a Work source; its remediations are declared
  actions on rows and reason-group headers, performed by the web client's
  `workActions` feature table. The `/problems` page, lanes and coverage
  meters are deleted; maintenance tools move to Settings → Maintenance.
- Saved views are `{key, label, filters}` over declared filters (ADR 0022);
  the Executor views (Automatic, Agent, Review, Waiting) and Problems are
  such views.

## Consequences

- A new list filter, exclusion or view is a declaration change; no route,
  wire object or SQL helper is added per surface.
- A new kind of work is a Work source in its domain; the queue, MCP and every
  client show it without central routing changes.
- A Problem's remediation must be expressible as a declared action and its
  client handler; bespoke Problems sections no longer exist.
- Breaking changes: the Work queue's `kind`, `source`, `vendor`, `waitingFor`,
  `nextAction` and explanation fields, the Suggestions `where{}` wire and its
  Exclude params, and the `/problems` route are removed without redirects.
