# Resumption and worker handoffs

Snapshot every page of the requested MCP queue before mutations: removing gaps
shrinks the queue and shifts later page indexes. Keep the initial candidate set
separate from outcome counts. Queue reduction alone does not prove completion.
Use Cubby MCP for household records; do not reconstruct them from database or
application internals.

Recover the requested history window through `activity.recent`, filtered to the
entity kind and channel. Follow the opaque `nextCursor` unchanged until the end
of the window. Include touched Products whose identifier gap cleared but that
still need metadata or useful images. Read their current full records; activity
is history, not current state. Retain source attempts and outcomes so unchanged,
exhausted evidence is not researched again. New evidence can reopen a candidate.

Keep private checkpoints outside the repository and `/tmp`, for example under
`~/.local/state/cubby-product-research/<session>/`: household evidence must stay
out of repository content, and resumable work must survive temporary-file cleanup
and reboot. Save each candidate
incrementally with its requested code, resolved canonical code, evidence tried,
proposal, uncertainty and outcome. Redirected aliases can resolve to one Product;
deduplicate by canonical identity before assigning disjoint lanes. Preserve both
codes for accounting rather than treating redirects as missing or duplicate work.

Preserve the member's model and speed choice for research workers under
[model routing](../../../../docs/agents/model-routing.md). Assign explicit,
disjoint candidates and permitted source tools; read-only workers return
proposals and hand mutating searches to the main agent. The main agent reviews
uncertain identities and verifies every write. A worker completion report must
name its persisted artifact and confirm it exists, parses, and accounts for its
assigned candidates. Raw read counts or a claimed filename are not researched
outcomes. Validate artifacts before accepting a lane as complete.

Save before/after snapshots for each write. Immediately before each mutation,
read the full live Product again, preserve unrelated values and check that the
proposal still applies. Read back facts, Sources, dataQuality and image results
afterward. Never mutate merely to reconstruct a missing checkpoint. Report
verified enrichment separately from exceptions, ambiguity, blocked source access
and unresearched work.
