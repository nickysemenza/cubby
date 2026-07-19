# Household ERP — Project Tracker Roadmap

**Status:** Design only — nothing here is implemented. The tracker itself
(projects / tasks / purchases, PRs #378–#382) is feature-complete as a
standalone module: consolidated CRUD, detail pages with full editing,
dependency edges, dashboard + charts, markdown notes, hovercards, global +
semantic search, MCP tools. What it is *not* yet is connected — no FKs to
product/inventory/location, no planning-grade budgeting. This doc captures the
three prioritized directions that turn it from a Notion replacement into a
household planning system. Priority order is deliberate.

Two schema affordances already exist and are load-bearing for this plan:
`task.projectId` is nullable (future inbox tasks) and `purchase.future` marks
planned-not-yet-actual spend
([schema.ts](../../apps/web/src/server/db/schema.ts) — `project` L776,
`task` L837, `purchase` L892).

---

## 1. Ranged estimate purchases (top priority)

**Problem.** When planning a project, cost lines are estimates with real
uncertainty — "electrical, $50–70k" — but `purchase.cost` is a single number.
Today an estimate must be entered as a fake point value, which poisons both the
plan (false precision) and the rollups (estimates and actuals sum together
indistinguishably except for the `future` flag).

**Schema.** Additive and nullable only (dev DB **is** prod Neon — no breaking
changes):

- Keep `cost` as the actual/settled amount.
- Add `costLow` / `costHigh` (`doublePrecision`, dollars, nullable) —
  meaningful while `future = true`. A point estimate is `costLow = costHigh`
  (or just one of them set).
- Lifecycle: an estimate purchase is `future: true` + a range; *settling* it
  records the real `cost` and flips `future` off. The range fields are
  retained after settling — estimate-vs-actual accuracy is itself interesting
  data (which categories do I under-estimate?).

**Rollups.** `projectRollups`
([project/analytics.ts](../../apps/web/src/server/repo/project/analytics.ts))
grows a planned-spend envelope alongside actual `spent`:
`plannedLow = SUM(COALESCE(costLow, costHigh, cost))` /
`plannedHigh = SUM(COALESCE(costHigh, costLow, cost))` over `future` purchases.
Stays a SQL aggregate — never denormalized (existing tracker rule).

**UI.**

- Purchase form + inline edit: when `future`, the cost cell becomes a range
  input (low–high, either side optional).
- Purchase list renders estimates as `$50–70k` (or `≈ $60k` for a point
  estimate) visually distinct from settled costs.
- Project detail + dashboard budget charts show three series: `costEstimate`
  (the project-level guess), the purchase-line envelope (low–high band), and
  actual spent. Budget-health chart gets the band treatment.
- A one-click "settle" action on an estimate purchase (enter actual cost →
  clears `future`).

**MCP.** `create_purchase` / `update_purchase` accept `costLow` / `costHigh`;
`list_purchases` / `get_project` return them.

---

## 2. Purchase ↔ product / inventory bridge

**Problem.** The tracker is an island: a purchase is free-text `name` + `cost`.
Buying a table saw or 40 2×4s creates a ledger line but no inventory — even
though cubby's whole premise is knowing what you own, where it lives, and what
it cost.

**Design.**

- Optional `purchase.productId` FK (branded, nullable). Most purchases
  (services, one-offs) stay unlinked; durable tools and materials link.
- A **convert-to-inventory** flow on a settled purchase: pick/create a product,
  pick a location → creates an `InventoryEntry` (the existing capture path,
  pre-filled from the purchase). The purchase keeps a pointer to what it
  produced.
- Linked purchases double as **price observations** for the product — a
  purchase of a known product at a known date/cost is exactly the data the
  costing engine's price field wants. Start read-only (show purchase history on
  the product page); promoting observations into `product.price` updates is a
  later, explicit step.
- Respect the removal-path invariant: any new delete/convert path cleans up
  embeddings in-transaction and honors soft-delete safety checks.

---

## 3. Maintenance + budgeting

Three semi-independent pieces, roughly in order of value:

- **Recurring maintenance tasks.** HVAC filters, gutters, smoke-detector
  batteries. A recurrence rule on a task template (simple interval — every N
  weeks/months — not full RRULE) + due-date generation for the next instance
  when one completes. Surfaces in the existing needs-attention panel.
- **Inbox tasks.** `task.projectId` is already nullable by design; build the
  UX: an inbox view for project-less tasks, quick capture via MCP
  (`create_task` without a project already works), and a "promote to project"
  affordance.
- **Problems detectors.** Extend the Problems system with tracker detectors:
  overdue tasks, projects whose spend exceeds `costEstimate` (or whose planned
  envelope does — see §1), stale `in_progress` projects with no recent
  task/purchase activity, `future` purchases whose `date` has passed
  (un-settled estimates).
- **Planned-vs-actual budget view.** Falls out of §1's envelope rollup: a
  per-project and cross-project view of estimate band vs. committed vs. actual,
  over time (monthly cash-flow projection from `future` purchase dates).

---

## Explicitly not planned

- **Purchaser as an entity** — `nicky|rebecca|both` stays a hardcoded enum;
  cubby is single-user by design.
- **`project.locations` → Location FK** — considered and deferred; the
  free-form `text[]` (house/site names) and the physical storage tree serve
  different purposes. Revisit only if §2 makes "materials for project X are on
  shelf B" a real query.
- **Restore/undo for tracker entities** — soft delete stays
  permanent-from-the-user's-perspective, same as everywhere else.
