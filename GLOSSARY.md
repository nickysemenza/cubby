# Cubby

One trusted household's record of what it owns, buys, eats and grows.

## Purchase research

**Email**:
A message Cubby scanned from a member's mailbox, including unrelated messages. Every Email retains its sender, subject and received date; its Relevance determines whether its body and attachments are retained.
_Avoid_: OrderMail, order mail, receipt email, scanned message

**Relevance**:
Whether an Email is related, unrelated or uncertain to the household's purchases, with the stage that decided it (rule, Jev, model or a member's resolution). Only a related or uncertain Email keeps its content.
_Avoid_: triage result, classification verdict

**Mail discovery**:
Unattended paging of a member's mailbox that records every Email's Relevance, keeps related and uncertain content, and records exact coverage.
_Avoid_: mail sync, Gmail scan

**Classification-only backfill**:
A Mail discovery pass over mailbox history that decides Relevance with rules and Jev alone and imports nothing, so Relevance can be reviewed before any Mail import.
_Avoid_: dry run, Jev-only scan

**Mail import**:
Unattended interpretation of classified Emails into Purchases, Expenses and Product resolutions.
_Avoid_: mail research, email processing

**Exact identity match**:
An existing Product that already owns one of an imported line's identifiers, or whose name or alias equals the line's name apart from letter case and surrounding spaces. A merely similar name is never an exact identity match.
_Avoid_: fuzzy match, likely duplicate

**Distinct-from decision**:
A recorded judgment that an imported line is a different Product from an exact identity match, carrying a Source that shows the difference (model, size, pack or kit contents). Without one, an import may not create a Product beside its exact identity match.
_Avoid_: force new, override

**Vendor alias**:
Another name a Vendor trades under, recorded by a member, a Vendor merge, or Sender proof, so import finds the existing Vendor by that name.
_Avoid_: vendor nickname, similar vendor

**Sender proof**:
An order Email arriving from a sender address already recorded on a Vendor, which proves that Vendor regardless of the merchant name the Email shows. A shared domain alone is not Sender proof.
_Avoid_: domain match

**Research queue**:
The derived, unstored list of household records whose quality further research could improve.
_Avoid_: worklist, enrichment queue, backlog

**Burn-down**:
A member's Claude or Codex session working through the Research queue with ordinary writes that carry Sources.
_Avoid_: enrichment run, sweep

**Source**:
A record of where a fact about an entity was seen: its URL, relevant quoted text, observation time, selected variant and who recorded it, optionally scoped to one field.
_Avoid_: evidence, caller observation, provenance, capture
