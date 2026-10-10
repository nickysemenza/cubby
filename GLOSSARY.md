# Cubby

One trusted household's record of what it owns, buys, eats and grows.

## Purchase research

**Email**:
A message Cubby scanned from a member's mailbox. Its Relevance decides whether Cubby keeps its content and links it to the Purchases it supports.
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

**Research queue**:
The derived, unstored list of household records whose quality further research could improve.
_Avoid_: worklist, enrichment queue, backlog

**Burn-down**:
A member's Claude or Codex session working through the Research queue with ordinary writes that carry Sources.
_Avoid_: enrichment run, sweep

**Source**:
A record of where a fact about an entity was seen: its URL, relevant quoted text, observation time, selected variant and who recorded it, optionally scoped to one field.
_Avoid_: evidence, caller observation, provenance, capture
