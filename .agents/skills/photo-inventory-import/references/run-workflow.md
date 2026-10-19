# Photo inventory run workflow

Coordinate one `photo_inventory` Run (`{{runId}}`) through Cubby MCP.
Activate the `photo-inventory-import` skill and apply its product identity,
grouping, ownership, and location rules.

1. In the hosted import agent, report preparing and call `claim_next_import_work`.
   An external Claude/Codex session uses the available MCP reads and proposals;
   it does not need hosted-only claim/progress tools. Pass `{{runId}}` as the
   public run code to `imports_read.photo_context`. It returns the owner, notes,
   and one page of photos in capture order with their analysis summaries; pass
   `nextCursor` back as `cursor` until it is null. For a multi-page run,
   propose each page's groups as you go, but hold back a page's last group
   until the next page shows whether the item continues.
2. For each distinct item, call `imports_read.photo_candidates` with its
   observed name and manufacturer; issue the calls for all items in one turn,
   since they are independent. Compare the physical variant to the returned
   Products. Prefer a matching Product with no own-item photo or earlier photo
   import, whether or not it has a vendor import or purchase. Read labels in
   context: fit text and a separate size marker can mean different things.
   Propose a strong existing match for human approval and state any uncertainty
   in its evidence. Leave genuinely ambiguous variants for the reviewer.
3. Cover every pending image exactly once with `photo_run.propose_groups`. Include
   `_runExecution: { run: "{{runId}}", operationId: <stable proposal id> }` on
   the mutation in an external member session (the hosted runtime supplies its
   private execution identity). Include each group's structured `review`
   decision, leaving ambiguous identity explicitly unresolved. Read `imports_read.photo_proposals` to check for conflicts and
   uncovered photos. The human approves groups; this agent does not call
   `photo_run.commit_group`.
4. Once every photo is covered by a valid proposal, the hosted agent calls
   `report_agent_progress` with `phase: "awaiting_approval"` and
   `awaitingApproval: true`, then end this submission. The run completes after
   the human approves or discards the last group. If safe grouping is blocked,
   call `stop_import_run_for_review` with the exact open question. An external
   session reports readiness or the open question in chat, then stops before
   approval.

Use photos only to identify physical items. Retailer browsing and purchase
inference belong to the purchase workflow. Use Cubby MCP tools for records. For image inspection, prefer host-supported
image bytes; use the browser viewer only when needed. Shell, SQL, scripts, and
arbitrary browser evaluation are outside the hosted run.
