# Burn-down

Burn-down is member-directed research and reconciliation for Cubby's derived
Research queue. Claude and Codex connect to Cubby through MCP, inspect a small
worklist, and use the matching workflow skill to resolve supported gaps. The
member's client supplies research and judgment; Cubby checks ownership,
identifiers, provenance, replay and safe writes. Work one record at a time, or
prepare a bounded batch when each record is independently settled.

## Start from the queue

1. Connect the Claude or Codex session to Cubby's MCP server using the client's
   normal MCP connection flow.
2. Open the derived **Research queue** saved view. It is available on Products,
   Purchases and Expenses; it is a view over current data, not a separate task
   list.
3. Choose one record or a small bounded batch, then load the skill that owns
   the work:
   - [Product enrichment](../../.claude/skills/product-enrichment/SKILL.md) for
     verified Product identity facts, identifiers, images and Sources.
   - [Purchase import](../../.claude/skills/purchase-import/SKILL.md) for order,
     receipt, Email and settlement evidence.
   - [Photo inventory import](../../.claude/skills/photo-inventory-import/SKILL.md)
     for belongings and wardrobe photos.

Use the member's browser session when the work depends on a logged-in retailer
page or web research. Use MCP for Cubby record reads and writes, and follow the
selected skill for any Cubby UI review step. Follow its read-before-write,
identity and verification steps.

## Research and write

Research the exact record and the fact that is missing. Prefer the evidence
already linked to the record, then check an authoritative source for unresolved
facts. Keep competing variants separate until evidence selects one. Ask the
member directly when ownership, identity, allocation or another material choice
remains ambiguous; do not silently choose a candidate.

Write only facts supported by evidence. Attach a Source to each researched
field, with its source URL, a short relevant quote, observation time and the
selected variant when applicable. For identifier collections, use the
supported add, replace or remove patch so unrelated identifiers remain intact;
read collision information before adding an identifier. Re-read after each
write and verify the stored value and its provenance. Batch settled writes only
when every record has its own evidence and preconditions.

When a fact cannot be found, record the sources and searches checked, mark that
gap unavailable using the owning skill's supported exception, and report it.
This closes the current queue gap without claiming the fact is known; new
evidence can reopen the work.

## Reconcile changed evidence

When new source evidence conflicts with accepted facts, reconcile explicitly:

1. **Compare** the new observation with the accepted source facts, identities,
   amounts and links. Preserve both what was previously accepted and what the
   new source says.
2. **Prepare** the proposed resolution and show the affected records and
   changes. Keep unresolved choices visible.
3. **Ask and commit**: ask the member about material ambiguity, then commit the
   reviewed resolution through the reconciliation actions exposed by the
   connected Cubby client. Let the server recheck current evidence and
   preconditions. If the required action is not available in that client yet,
   leave the finding open and report the gap; do not invent a tool name or
   claim the resolution was committed.

Exact replay of unchanged evidence can follow the workflow's replay-safe path.
Changed accepted financial facts require explicit reconciliation. Sources that
support field values, import-source ownership and execution replay have
different roles; do not substitute one for another.

## Photos and wardrobe

Use photos to identify a physical item, match or create its Product, retain
item and label images, and record ownership and a known location. For apparel,
keep the observed size and color in the Product title and transcribe other
printed tag facts verbatim in notes. Preserve image and label evidence.

A photo does not establish a Purchase, Expense, price, vendor, receipt or
payment, and it never receives inventory. Do not invent those facts or change
quantities from a photo. A later order source can establish purchase details;
receiving remains a separate member decision.

## Report the outcome

For each record, report what was verified, which Sources were added, any
unavailable facts or open ambiguity, and whether writes were committed. Keep
partial research distinct from verified completion. For photo work, also report
matched versus created Products, skipped images and reasons, and unresolved
ownership or location.

This workflow follows [ADR 0011](../adr/0011-email-as-a-first-class-entity.md)
and [ADR 0012](../adr/0012-import-convergence-through-burn-down.md). Those ADRs
describe accepted direction; use only actions available in the connected
client, since parts of the UI workflow may still be in progress.
