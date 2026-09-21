---
name: log-household-maintenance
description: Log completed or planned household maintenance in Cubby, connect it to the right annual Project and durable Product, and receive inventory only when the user asks. Use when the user reports chores, cleaning, servicing, repair, upkeep, or a durable item encountered while recording that work.
---

# Log household maintenance

Keep the maintenance record, product identity, and inventory receipt separate.

1. Find the existing annual maintenance Project using the action, subject, and
   stated year. Search before creating; ask when more than one live Project is
   plausible. A dated completed action becomes a done Task with that due date.
2. Read the Project's live Tasks once, then compare each proposed action and
   durable subject in memory. Reuse a clear same-date duplicate; a similar event
   on another date is new.
3. Resolve the durable Product by exact identity before linking
   `subjectProductId`. A cover, filter, cleaner, or accessory is not the
   maintained subject. Create a Product only when identity and ownership are
   established; use one complete `entity` create and do not invent identifiers,
   price, or model.
4. Resolve all dependencies, then send independent Task creates or updates in
   one `entity_batch`; inspect every ordered result and retry only failed items.
   Use `other` for general cleaning and `appliances` for appliance upkeep when
   no closer trade is known.
5. Receive or move Inventory only when the user explicitly asks to inventory or
   place the durable. Read the Product and Location first, avoid a duplicate,
   and use `1 each` only when the evidence establishes one item.

Read back the affected Tasks and any Product, Expense, or Inventory row in
batched id reads. Confirm the date, status, Project, durable subject, quantity,
and Location; report skipped inventory or unresolved identity plainly.
