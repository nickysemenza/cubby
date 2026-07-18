# Notion → Cubby: projects / tasks / purchases migration

**Goal:** make cubby's Postgres the source of truth for the three Notion databases
(projects, Tasks, Purchases), then retire them from Notion. The freeform Notion
workspace pages (Backyard/Kitchen "Main Page" trees, Extension Project Scope, their
sub-pages and inline mini-databases) are **explicitly out of scope** and stay in
Notion. The Notion **recipes** DB import path (`notion-recipe.ts`) is untouched.

## Current state

- `list_projects` / `list_tasks` / `list_purchases` / `get_project_content` MCP tools
  and the `/projects` dashboard + detail UI are thin proxies over the Notion API
  (`server/clients/notion.ts`, `server/api/routers/notion.ts`,
  `server/mcp/tools/notion.tools.ts`), with a 5-min LRU cache. No DB tables exist.
- Data volume (2026-07-17): 60 projects, ~1.1k tasks (all project-linked),
  ~900 purchases (all project-linked). Projects and tasks have self-referential
  Blocked by / Blocking relations. Projects have Notion rollups (cost, progress,
  counts) that must become SQL aggregates.
- Project page bodies are mostly thin (blank / one link / one photo). A handful of
  older builds have real content: bill-of-materials tables and photo galleries.

## Decisions (agreed 2026-07-17)

1. **Page bodies:** convert each project row's body to a markdown `notes` field
   (reusing the PR #377 markdown-notes pattern); download body/cover images from
   Notion's signed URLs into cubby's image storage and attach via the existing
   image infrastructure.
2. **UI:** full CRUD — projects/tasks/purchases become first-class entities
   (RTable list pages with inline editing, detail via the `Page` shell, forms),
   and the existing dashboard/charts keep working against the DB.
3. **Enums:** migrate option sets verbatim with emoji stripped; statuses become
   snake_case enums (projects: `planning | not_started | in_progress | done`;
   tasks: `not_started | later | in_progress | blocked | done`; purchase category:
   `materials | tools | services`).
4. **Self-contained module:** no FK links into Product/Location/valuation for now.
5. **Public-repo privacy rule:** house names/addresses are **not** committed as
   code enums — project `locations` is `text[]`; filter options derive from data.
   No dollar figures or addresses in committed docs/fixtures/tests. The archive
   dump lives outside the repo.

## Phase 1 — Schema

New tables in `schema.ts` (additive + nullable-friendly: dev DB **is** prod Neon,
so columns land via `db:push` before any code depends on them):

- **`project`** — `pkUuid<ProjectId>`, `name`, `status`, `kind`
  (`furniture | workshop | household | renovation | garden`), `locations text[]`,
  `costEstimate numeric`, `startDate` / `endDate date`, `icon text` (emoji),
  `notes text` (markdown), `notionPageId text` (unique, provenance),
  `baseTimestamps()`, `softDeletedAt()`. Images (cover + body gallery) via the
  existing image tables (`hasImages` trait).
- **`projectDependency`** — `(projectId, blockedByProjectId)` unique pair;
  "blocking" is the reverse read.
- **`task`** — `pkUuid<TaskId>`, `name`, `status`, `dueDate` (+ nullable
  `dueEndDate`; Notion Due supports ranges), `category text` (verbatim option
  set, kept as text — it's already organic), `person` (`nicky | rebecca`,
  nullable; mapped from Notion user IDs at import), `projectId` FK (nullable to
  allow future inbox tasks; every migrated row has one), `notionPageId`,
  timestamps, soft delete.
- **`taskDependency`** — same shape as `projectDependency`.
- **`purchase`** — `pkUuid<PurchaseId>`, `name`, `cost numeric`, `date`
  (+ nullable `endDate`), `category`, `subcategory text` (emoji stripped),
  `purchaser` (`nicky | rebecca | both`, nullable), `url text`, `notes text`,
  `future boolean default false`, `projectId` FK, `notionPageId`, timestamps,
  soft delete.

Plumbing that must land with the tables:

- Branded IDs `projectId` / `taskId` / `purchaseId` in
  `@cubby/schemas/identifiers` (+ `unsafe*Id`); `.$type<>()` brands on all
  PK/FK columns.
- Entity manifest entries (`entity.ts` + `entityManifest`): auditable, countable,
  soft-delete, hasImages (project only), mcp ops. The drift test will force the
  derived sets and `/entities` page into sync.
- Rollups as repo-layer SQL: `projectRollups(db, ids)` → spent (SUM of live
  purchases), task progress (done/total), counts. Never recomputed client-side.
- **Deferred:** entity embeddings / global search for these entities. When added
  later, the removal-path invariant applies (`softDeleteEntityEmbeddingsTx` in
  every delete path).

## Phase 2 — One-time import (idempotent)

A maintenance script (`apps/web/scripts/import-notion-projects.ts`, run via tsx
locally against Neon; **not** wired into the app) that:

1. Reads the three data sources with the existing `NotionClient` pagination.
2. Upserts rows keyed on `notionPageId` (re-runnable; re-import updates in place).
3. Resolves relations in a second pass via the `notionPageId → id` map
   (project links, both dependency tables).
4. Maps Notion `Person` user IDs → `nicky`/`rebecca`; strips emoji from
   subcategory/category values; converts statuses to enum values.
5. Fetches each project page body → markdown (`blocksToMarkdown` on top of the
   existing `blockToNotionBlock` output: paragraphs, headings, lists, to-dos,
   **tables**, links, columns flattened); downloads images (body + cover) through
   the image-upload pipeline and rewrites body references to attached images.
6. Backfills `createdAt` from Notion `Created`.
7. Prints a reconciliation report: row counts per table, per-project cost sums
   (import aborts nothing on mismatch — it reports), unmapped/odd values
   (e.g. suspicious pre-2000 purchase dates) for manual review.

Before deletion (Phase 5), also dump raw Notion JSON + page bodies + images to a
local archive directory **outside the repo** as a belt-and-suspenders backup.

## Phase 3 — Backend swap

- `server/repo/project/`, `repo/task/`, `repo/purchase/` using
  `entity-crud-factory` (diff-audited updates), `notDeleted`, `withTransaction`.
  Delete cascades: deleting a project soft-deletes nothing implicitly — tasks and
  purchases block deletion (dependency safety check) or are explicitly bulk-moved;
  dependency-pair rows are cleaned up in the same transaction.
- tRPC routers `project` / `task` / `purchase` (router-calls-repo style; a
  service is only warranted if a genuine cross-cutting rollup emerges — the
  rollup query lives in the project repo's `analytics.ts`).
- A DB-backed `project.dashboard` procedure that returns the same shape the UI
  consumes today (projects + tasks + purchases + resolved names), so the chart
  components swap with minimal churn.
- MCP: replace the four hand-rolled Notion tools with `registerEntity*` factory
  registrations (list/get/create/update/delete per manifest). `get_project_content`
  becomes part of `get_project` (notes markdown + image refs).
- Remove the projects/tasks/purchases surface from `notion.ts` (client slims down
  to the recipes path), delete `notion.tools.ts` and the `notion` router's
  dashboard/projectImages/projectContent procedures once the UI is off them.

## Phase 4 — UI

- Re-point `projects-dashboard.tsx`, `project-detail-page.tsx`, and the chart
  components to the new procedures. `notion-content.tsx` → markdown renderer
  (existing `markdown.tsx`) + image gallery.
- New list pages `/tasks` and `/purchases` (RTable: sorting, filters incl.
  relation-presence, inline editing per PR #375 primitives, optimistic delete via
  `useEntityList`), plus create/edit forms (`useActionMutation`,
  `requiredProductField`-style zod fields, quick-add purchase as the common path).
- `/projects` keeps the dashboard as index; project detail gets
  `Page variant="detail"` + `DetailSections` (spec-plate: status, kind, dates,
  estimate vs actual, dependency links) with the notes/gallery below.
- Nav entries; layout primitives (`Row`/`Stack`/`Grid`/`Section`), spacing scale,
  and color tokens per repo conventions (map statuses to `positive`/`warning`/
  semantic tokens — no raw greens/ambers).

## Phase 5 — Verify, cut over, delete

1. `pnpm run format:write`, `pnpm check`, `pnpm typecheck`, unit + integration
   (import upsert idempotency, manifest drift, rollup math), E2E for the new
   pages (E2E gates deploy).
2. Run the import against Neon; eyeball the reconciliation report; compare
   dashboard totals against Notion side-by-side.
3. Ship via PR branch(es) (main auto-deploys): suggested split —
   **PR A** schema + repos + import script, **PR B** router/MCP swap + Notion
   code removal, **PR C** UI. A and B can merge together if small enough.
4. After a comfortable soak: archive dump (Phase 2 step), then delete the three
   databases in Notion (manual step, done by Nicky — not the agent). The
   Household workspace pages remain.

## Risks / gotchas

- **Prod-DB dev:** `db:push` hits prod Neon immediately — schema must stay
  additive; never rename/drop during the transition.
- **Notion signed image URLs expire (~5 min):** the import must download at
  fetch time, not stash URLs.
- **Relation resolution:** Notion page URLs come in dashed and undashed UUID
  forms — normalize before keying.
- **Egress cap:** Neon free tier egress — the import is write-heavy (fine), but
  don't add polling loops to the new dashboard.
- **workerd clock:** if dashboard rollup queries ever look "slow", re-read the
  frozen-clock note in CLAUDE.md before optimizing the wrong thing.
