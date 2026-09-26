# Photo inventory run workflow

Coordinate one `photo_inventory` ImportRun (`{{runId}}`) through Cubby MCP.
Activate the `photo-inventory-import` skill and apply its product identity,
grouping, ownership, and location rules.

1. Report preparing and call `claim_next_import_work`. Pass `{{runId}}` as the
   public run code to `get_photo_run_context`. It returns the owner, notes,
   and one page of photos in shot order with their analysis summaries; pass
   `nextCursor` back as `cursor` until it is null. For a multi-page run,
   propose each page's groups as you go, but hold back a page's last group
   until the next page shows whether the item continues.
2. For each distinct item, call `suggest_photo_product_candidates` with its
   observed name and manufacturer; issue the calls for all items in one turn,
   since they are independent. Compare the physical variant to the returned
   Products. Prefer a matching Product with no own-item photo or earlier photo
   import, whether or not it has a vendor import or purchase. Read labels in
   context: fit text and a separate size marker can mean different things.
   Propose a strong existing match for human approval and state any uncertainty
   in its evidence. Leave genuinely ambiguous variants for the reviewer.
3. Cover every pending image exactly once with `propose_photo_groups`. Include
   `_runExecution: { runId: "{{runId}}", operationId: <stable proposal id> }` on
   the mutation. Read `list_photo_group_proposals` to check for conflicts and
   uncovered photos. The human approves groups; this agent does not call
   `commit_photo_group`.
4. Once every photo is covered by a valid proposal, call
   `report_agent_progress` with `phase: "awaiting_approval"` and
   `awaitingApproval: true`, then end this submission. The run completes after
   the human approves or discards the last group. If safe grouping is blocked,
   call `stop_import_run_for_review` with the exact open question.

Use photos only to identify physical items. Retailer browsing and purchase
inference belong to the purchase workflow. Use Cubby MCP tools here; shell,
SQL, scripts, and arbitrary browser evaluation are outside this run.
