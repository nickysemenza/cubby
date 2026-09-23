# Worked example

Three representative rows from a seasonal plan, walked through the mapping
in [mapping.md](mapping.md). Shortcodes below are placeholders
(`LOC-XXXX`/`PRJ-XXXX`/`TSK-XXXX`/`PLANT-XXXX`/`PLT-XXXX`) — never copy real
household codes into a skill file; resolve and create against the live
catalog instead.

Assume the season Project already exists: `PRJ-TEST` ("Example Beds Fall/
Winter 2026–27", `kind: "garden"`).

## Row 1 — "Broccoli ×3, bed 3, plant now, DiCicco or Belstar"

A calendar row with an assigned bed and an immediate window. Produces a Task
plus a planted Task's Planting.

1. Resolve `Location` "bed 3" → existing `LOC-B3XX` (`type: "bed"`), or
   create it if this is the first plan to mention it.
2. Resolve the cultivar via `resolve_plants` with
   `{ "name": "DiCicco", "gardenGuideKey": "broccoli" }` → `PLANT-BRCL`
   (created if unresolved); note "or Belstar" in that Plant's `notes`.
3. Create the `Task`:
   ```json
   {
     "action": "create",
     "entity": "task",
     "data": {
       "name": "Direct-sow broccoli — bed 3",
       "projectId": "PRJ-TEST",
       "dueDate": "2026-09-20"
     }
   }
   ```
   → `TSK-BRC3`
4. Create the `Planting`:
   ```json
   {
     "action": "create",
     "entity": "planting",
     "data": {
       "plantId": "PLANT-BRCL",
       "locationId": "LOC-B3XX",
       "status": "planned",
       "quantity": "3",
       "plannedWindow": "plant now",
       "taskId": "TSK-BRC3"
     }
   }
   ```
   → `PLT-BRC3`. "Plant now" is still `status: "planned"` — the household
   flips it to `"growing"` and sets `sowedOn` once they've actually sown it.

## Row 2 — "Fava — Windsor, ¾ lb, Nov"

A calendar row with a future window and no bed assigned yet in the plan.
Produces a Task plus a planned Planting with `locationId: null`.

1. Resolve `{ "name": "Windsor", "gardenGuideKey": "bean-fava" }` via
   `resolve_plants` → `PLANT-FAVA` (displays as "Windsor · Fava bean").
2. Create the `Task`:
   ```json
   {
     "action": "create",
     "entity": "task",
     "data": {
       "name": "Sow fava beans",
       "projectId": "PRJ-TEST",
       "dueDate": "2026-11-01"
     }
   }
   ```
   → `TSK-FAVA`
3. Create the `Planting`:
   ```json
   {
     "action": "create",
     "entity": "planting",
     "data": {
       "plantId": "PLANT-FAVA",
       "locationId": null,
       "status": "planned",
       "quantity": "3/4 lb",
       "plannedWindow": "Nov",
       "taskId": "TSK-FAVA"
     }
   }
   ```
   → `PLT-FAVA`. `locationId` is filled in later, when the household or a
   follow-up plan assigns a bed.

## Row 3 — "Mesh drawstring bags ×20"

A shopping-list line with no crop and no bed — Task only, no Planting.

```json
{
  "action": "create",
  "entity": "task",
  "data": {
    "name": "Buy mesh drawstring bags ×20",
    "projectId": "PRJ-TEST",
    "dueDate": "2026-10-01"
  }
}
```

→ `TSK-BAG2`. Check `resolve_products` first in case a matching Product
already exists to set as `subjectProductId`; if not, leave it unset — this
skill never creates a Product for an unbought line.

## Verification for this batch

- `entity list planting {filters:{taskId:"TSK-BRC3"}}` and `{filters:
{taskId:"TSK-FAVA"}}` each return exactly the one planned Planting created
  above.
- `entity list task {filters:{projectId:"PRJ-TEST"}}` includes all three
  Tasks, with `dueDate` matching the plan's headings.
- The planning calendar shows `TSK-BRC3`/`TSK-FAVA`/`TSK-BAG2` on their due
  dates once the batch completes.
