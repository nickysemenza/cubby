# Cubby Long-Term Backlog — the Household OS north star

**Status:** Vision / backlog — nothing here is committed work. This is the wide-angle
companion to the focused near-term plan in
[2026-07-18-household-erp-roadmap.md](2026-07-18-household-erp-roadmap.md); where an
item is already specced there in detail, this doc points to it rather than
re-specifying it.

**The through-line.** Cubby's data model is nearly complete, and it is the only
database that knows one household's *space, stuff, food, spend, and time* in a single
schema — with compute engines (costing / availability), embeddings + global search,
an MCP agent surface, a barcode scanner, and image/PDF infra already attached. Given
that, the decade-long constraint is not *what to model* — it's **capture friction in**
(getting reality into the DB cheaply) and **synthesis out** (turning the accumulated
record into decisions and memory). Most of what follows is one of those two things.

Cubby is a single-user tool ([cubby-single-user-tool]); optimize every one of these
for one household's taste, not for generality.

---

## Tier 0 — near-term / quick wins

Small, independent, high leverage. These are the spine the bigger bets hang off.

1. **`list_actionable_tasks`** — a repo query for *unblocked* tasks (optional
   due-soon / project / person filters), exposed as both an MCP tool and a "what can
   I do this weekend" UI view. Include a transitive blocked-chain read ("why is this
   blocked"). The tracker already stores dependency edges; this is the missing
   *computed* read over them, and it is the data the weekly-brief agent (Tier 2)
   needs. Highest value-per-effort item in the doc.
2. **`task.parentTaskId`** — additive nullable self-FK; one level of subtasks in the
   UI (checklist + `N/M` chip on the parent, parent status stays manual). Also yields
   the punch-list-as-subtasks convention for free. Cheap to add while the schema is
   young.

*(Image / document attach over MCP — receipt photos, progress photos, permit PDFs — is
already shipped as the `attach_file` tool; the conversational-capture tiers below build
on it.)*

---

## Tier 1 — the connected tracker (detailed elsewhere)

These turn the standalone tracker into a household planning system. All three are
specced in [the ERP roadmap](2026-07-18-household-erp-roadmap.md); summarized here so
this backlog reads as a complete map:

- **Ranged estimate purchases** — `costLow`/`costHigh` for `future` spend, a settle
  action, planned-envelope rollups. (ERP roadmap §1.)
- **Purchase ↔ product / inventory bridge** — optional `purchase.productId`,
  convert-to-inventory flow, purchases as price observations. This is the
  BOM/materials layer's foundation. (ERP roadmap §2.)
- **Maintenance + budgeting** — recurring maintenance tasks, inbox tasks, tracker
  Problems detectors, planned-vs-actual budget view. (ERP roadmap §3.)

**One extension worth pulling forward:** an explicit **`projectMaterial` BOM** table
(quantity + free-text unit, optional product resolution, durable-vs-consumable flag)
sitting on top of the purchase↔product bridge, giving **have / need / buy** per project
via the availability engine and a shopping list from shortfalls. No reservations, no
auto-decrement — audits are the backstop, "mark consumed" is an optional explicit
action. This is the feature that most justifies the whole tracker existing: Notion
could never see the garage.

---

## Tier 2 — synthesis out (turn the record into decisions)

4. **House timeline & "Year in the House."** Everything cubby records is timestamped —
   meals, projects, purchases, service events, photos. Build unified chronological
   views over all of it: a scrollable house journal, before/after sliders from
   progress photos, and an annual wrapped-style report. Zero new data entry; pure
   synthesis over existing tables.
5. **Weekly standup agent.** A scheduled agent that briefs what moved, what's blocked
   and why, budget burn, and what's schedulable this weekend given the calendar (and
   weather, for outdoor kinds). Nearly free once Tier 0 #1 lands — the rollups and
   actionable-tasks query supply all the data.
6. **Household balance sheet — actuarial cubby.** Generalize location valuation into a
   household financial model: a **capex forecast** from asset ages + expected
   lifespans ("roof and water heater both die within ~5 years: ≈$14k"), cost-per-
   project analytics (tools + materials vs. output, the cost-per-recipe move applied
   to woodworking), and insurance-claim + cost-basis exports. The costing engine
   pointed at the house.

---

## Tier 3 — capture in (drive the write-cost toward zero)

7. **Ambient capture.** The long-term bottleneck. Every low-effort input path:
   voice memos from the shop ("cubby: used the last of the epoxy"), an
   email-forwarding address that files whatever is sent to it, a photo share-sheet,
   NFC tags on machines (tap → service log, one better than the existing QR labels).
   Each path multiplies how much of reality actually reaches the DB. The Home
   Assistant voice tie-in (below) is the flagship instance.
8. **Standing agents — delegation, not tools.** Agents with *jobs* rather than
   answers-on-demand: a *registrar* watching Gmail for warranties / receipts / order
   confirmations and filing them against products & projects (you approve, it files);
   a *quartermaster* watching consumable inventory and drafting the shopping list; a
   *foreman* that notices a project untouched for weeks and raises it in the brief.
   Rides on the MCP tools already planned.

---

## Tier 4 — the big bets (whole new classes)

9. **Digital twin / spatial memory.** The location tree is secretly a building model —
   attach knowledge to *space*, not just stuff. Flagship: **before-drywall photos**
   (wire runs, pipe routes, blocking) pinned to the wall/room they live inside, so
   "can I cut into this wall?" is answered by *showing the inside of it* years later.
   Plus shutoff-valve locations, breaker maps, paint-per-room. **This is the only
   item with a hard, unrepeatable deadline: the extension build is the once-ever
   chance to capture the walls before they close.** Seedable from Home Assistant's
   area/device registry.
10. **Grow-to-table loop.** Garden is already a project kind; locations, inventory,
    recipes, and meal planning are one schema. Close the loop: garden beds become
    locations, plantings become dated records, **harvests become pantry inventory**,
    and the recipe-availability engine points at the yard ("what can I cook from the
    garden this week"). The most cubby-native feature imaginable — nobody else can
    build it, and half the machinery exists.
11. **Heirloom outputs — designed for decades.** Single-user software dies with
    migrations and enthusiasm. Build outputs that outlive the app: a house manual for
    a future owner, a printed project yearbook, a documented archive format. Having
    just retired Notion, designing cubby's own graceful exit hatch is the mature
    version of that instinct.

---

## Home Assistant integration (cross-cutting)

HA is the *senses and voice* of the house; cubby is the *memory and ledger*. Splits by
direction:

**HA → cubby (sensors feed the ledger):**
- **Runtime-based maintenance** — smart-plug / HVAC runtime gives *actual* usage, so
  "nozzle check every ~300 print hours" becomes automatic and honest. This is the good
  version of hour-meters we otherwise reject (rejected only because *manual* tracking
  is the anal-detail cliff; automatic is free).
- **Measured project ROI** — after an insulation / heat-pump / window project, show the
  before/after energy curve on the project detail page. Cost and measured savings on
  one screen.
- **Faults → tasks / Problems** — leak sensor, sump over-cycling, freezer temp
  excursion (inventory risk) → an HA automation files a cubby task/Problem against the
  right *asset*, next to its service history.
- **Weather stamping** — daily-log entries and outdoor task scheduling pull HA's local
  weather.

**Cubby → HA (the ledger informs the house):**
- **Voice capture via Assist** — the flagship of ambient capture (Tier 3 #7); shop /
  kitchen satellites route spoken logs to cubby's MCP tools.
- **Shopping-list bridge** — cubby *computes* the list (food + BOM shortfalls); HA's
  todo lists (`HassListAddItem`) *display and speak* it on the kitchen tablet.
- **Glance dashboard** — a Lovelace / e-ink panel: maintenance due, this weekend's
  actionable tasks, tonight's planned meal.

**Plumbing — use both:**
- *Agent-mediated* (works today, no new infra): scheduled agents already sit beside the
  HA MCP — good for briefs, ROI, and list sync.
- *Direct webhook* (for real-time): one authed CF Worker endpoint that HA automations
  POST to for sensor-grade events (leaks, excursions).

---

## Explicitly rejected (recorded so they don't resurface)

- **Monarch / finance sync** — purchases stay a hand-curated ledger.
- **Receipt-export importers (Amazon / Home Depot)** — hostile, unmaintained formats;
  MCP conversational capture carries ingestion, and a one-off throwaway script (in the
  spirit of the retired Notion import) covers any historical backfill itch.
- **Specs / sizes registry** — too granular to be worth structured modeling.
- **Offcut / scrap inventory** — anal-detail cliff.
- **Project templates / playbooks** — a markdown notes field at the right altitude
  beats a template system.
- **Manual hour-meter maintenance intervals** — only worth it automated via HA.
- **Cross-project material allocation** — the complexity cliff where Procore lives; for
  one user, at most a "also needed by project X" hint.
- (See also the ERP roadmap's "Explicitly not planned": purchaser-as-entity,
  `project.locations` → Location FK, tracker restore/undo.)

---

## Suggested spine

If forced to pick the load-bearing sequence: **Tier 0 #1** (actionable tasks) — attach
is already shipped (`attach_file`) — then **ambient / voice capture** (Tier 3 #7); those
make the MCP agent able to both *see* and *ingest*, which every later tier compounds on.
And grab
**before-drywall photos** (Tier 4 #9) opportunistically *now*, because it is the single
item with a deadline that does not come back.
