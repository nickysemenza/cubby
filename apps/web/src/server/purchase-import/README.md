# Purchase import: Mail import, member imports and Burn-down

[ADR 0010](../../../../../docs/adr/0010-mail-import-unattended-burn-down-interactive.md)
splits purchase work in two (vocabulary: [GLOSSARY](../../../../../GLOSSARY.md)):

- **Mail import** (unattended): Gmail discovery classifies and retains order
  Email, and a Pi agent turns it into Purchases, Expenses, Product resolutions
  and Email links. It reads only Email; there is no browser and no web search.
- **Burn-down** (interactive): a member's Claude or Codex session works the
  Research queue (the `research-queue` saved views over existing data-quality
  gaps) with its own browser, writing through ordinary MCP writes that carry
  Sources (`repo/entity-source.ts`).

Both use the same public tools. Cubby owns ownership, retained-Email checksums,
replay, identifier collisions, money conservation, stock neutrality and safe
writes; the caller owns research and judgment. An absent caller leaves work
pending: nothing here starts Product research.

## Mail import, end to end

1. **Discovery** (`gmail/discovery.ts`, the `MAIL_DISCOVERY` Workflow) pages a
   connected mailbox (`-in:spam -in:trash`), freezes each provider page in
   `Run.progress`, and replays it until its page commits. `gmail/ingest.ts`
   classifies each message (`gmail/triage.ts` rule/Jev, then
   `gmail/relevance.ts` for uncertain mail) and records the deciding stage and
   reason on `MailboxMessage`. Related originals become `OrderMail`; unrelated
   mail keeps only its provider identity. Coverage is checkpointed with a
   compare-and-swap in the same transaction as the page's events
   (`gmail/persistence.ts`).
2. **Admission** (`mail-import-run.ts`) freezes up to 50 Emails' checksums into
   one `mail_import` Run with a RunTarget per Email, assigns ownership through
   `MailboxMessage.runId`, and dispatches `start_or_resume` to
   `PURCHASE_AGENT_QUEUE` after commit (`dispatch.ts`). Paid inference is
   admitted per call against the Run's execution authorization
   (`runs/execution-*`).
3. **Pi** (`agent-host.ts`, `server/purchase-agent/`) runs on the generic agent
   tools (`claim_next_import_work`, `report_agent_progress`,
   `stop_import_run_for_review`) plus the MCP actions its manifest mounts
   (`packages/schemas/src/import-run-agent.ts`), called in process through the
   MCP handler with a run-bound delegation (`agent-services.ts`
   `mcpFetch`). Instructions: `.claude/skills/purchase-import/references/mail-import.md`
   via `server/purchase-agent/import-run-workflows.ts`.
4. **Writes**: `imports_read.mail` reads a retained Email (`mail-tool.ts`
   `readMail`); `purchase_import.prepare/commit` (`import-orders.ts`) import an
   order through `writer.ts`, and a mail-sourced commit (message or
   attachment) links and settles the Email as the Purchase's confirmation;
   `mail.resolve` records a lifecycle link, an unresolved gap or an unrelated
   disposal (which deletes the retained copy unless a reviewed decision or
   import uses it; the daily catch-up retries a disposal lost after its
   disposition, and a repeated `unrelated` resolve replays without the
   copy). A Mail import Run may touch only the Emails it admitted, may
   prepare only their mail sources, and is refused by every mail call once
   it is cancelled, finished, retired or deleted. New preparations may not
   name the retired `browser_order` source kind; stored rows keep it.
5. **Settlement**: Pi's settled submission reconciles the Run
   (`run-service.ts` `reconcileSettledRun`); the daily cron expires stale Runs
   and destroys settled Runs' transcripts (`run-retirement.ts`), oldest
   first in bounded batches; the destroying call and an immediate follow-up
   that reaches a fresh, empty coordinator let one pass stamp
   `Run.retiredAt`, and a failing coordinator does not block the Runs behind
   it. Runs of retired purposes are destroyed by their stored
   coordinator identity without loading the current agent. Once disposal is
   authorized the coordinator writes a durable fence table, refuses every
   entry point (also after a restart) and drains admitted ones before
   deleting, so nothing recreates storage before `retiredAt` is stamped; an
   inventory holding only the fence is empty. A stored finding whose fix kind is retired reads as having no
   executable fix (`storedImportFix`).

## Member imports

A member (or their Claude/Codex session) calls the same
`purchase_import.prepare` without a Run: it opens a `file_import` Run keyed by
the operation id and returns its `RUN-` code, which `commit` names in
`_runExecution.run`. Each order names its Vendor (`vendorId`, or `vendor.name`
to reuse an exact-name Vendor). Replay is by operation id (`RunOperation`), and
the `ImportSourceClaim` fence keeps a source from importing twice. A receipt
photo becomes a Purchase through ordinary booking and attachment; its attached
receipt puts the Purchase in the Research queue through `purchase_itemization`
until a session itemizes it.

## Where to look

| Need                                       | File                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| Public mail tool (read, search, resolve)   | `mail-tool.ts`, `packages/schemas/src/mailbox-research.ts`     |
| Import writers                             | `import-orders.ts`, `writer.ts`, `writer-policy.ts`            |
| Mail import admission                      | `mail-import-run.ts`                                           |
| Run lifecycle, approvals, controls         | `run-service.ts`                                               |
| Agent capabilities per Run purpose         | `capabilities.ts`                                              |
| Gmail discovery, classification, retention | `gmail/`                                                       |
| Pi host and services                       | `agent-host.ts`, `agent-services.ts`, `server/purchase-agent/` |
| Findings and their fixes                   | `findings.ts`                                                  |
| Sources                                    | `server/repo/entity-source.ts`                                 |

## Hidden dependencies

- Pi's instructions are skill Markdown (`mail-import.md`, `extraction.md`, the
  settlement rules) selected in `import-run-workflows.ts`; editing them changes
  production behavior.
- `server/purchase-agent/signals.ts` bytes are matched by the workerd scripted
  model; keep them stable.
- Pi mounts MCP tools from the same compiled catalog the MCP server lists
  (`server/mcp/agent-tool-catalog.ts`); renaming a tool or action changes both.
