# Purchase import: how a Run moves through the Worker

A purchase-import Run spans the web Worker's request path, its purchase agent,
and a Mac browser. The host code here owns every write. The purchase agent
(`server/purchase-agent/`) runs in the same Worker but owns only the model
conversation: it reaches Cubby through one Run's services and nothing else
(the boundary: [infrastructure](../../../../../docs/infrastructure.md#purchase-agent)).

## One Run, end to end

1. **Start.** `targeted-run.ts` (`startTargetedImport`, `dispatchStartedRun`)
   commits the Run and sends a `start_or_resume` event to the
   `PURCHASE_AGENT_QUEUE` (`cubby-purchase-agent`). A failed send is recorded
   as `dispatch_failed` and is never thrown.
2. **Coordinator.** The Worker's queue handler (`cf-server.ts`) loads
   `server/purchase-agent/queue.ts` (`consumePurchaseAgentQueue`), which wakes
   the per-Run `PurchaseImportRunAgent` Durable Object. Its exported shell
   (`agent-host.ts`) loads the agent (`server/purchase-agent/run-agent.ts`) on
   first use and forwards `dispatch`. Queue events reach the model as
   `<signal type="…">` user text (`signals.ts`).
3. **Tools call Run services.** Agent tools (`server/purchase-agent/tools.ts`)
   and the agent's Cubby MCP calls use the narrowed environment
   (`server/purchase-agent/environment.ts`) that `agent-host.ts` builds.
   `agent-services.ts` implements it: each method parses its input
   (`@cubby/schemas/purchase-agent-services`), opens its own database scope,
   and wraps a same-named function in `run-service.ts`. MCP calls run the MCP
   handler in process with a fresh run-bound delegation bearer per request.
4. **Browser commands.** `issueBrowserCommand` (in `run-service.ts`) enqueues
   on the bridge Durable Object (`durable-object.ts`,
   `PurchaseImportDurableObject`, one per vendor account). The Mac connects
   through `direct-socket-route.ts`. A Mac result publishes a `browser_result`
   event to the same queue, a reconnect publishes `browser_connected`, and the
   agent then calls `readBrowserCommandResult`.
   An enrichment run works its targets in one order (`targetWorkOrder`):
   a capture is retained for the target the agent last claimed, and
   `product_enrichment.skip` closes a target no page proves. Identifier commit
   refusals include the failed proof guard. A retailer source mismatch reports
   the host-derived source slugs the importer accepts; correct the source and
   retry with the same target's retained evidence before treating the Product
   as unprovable. Wrong-target evidence, off-vendor URLs, missing structured
   data and ambiguous variants remain refused.
5. **Writes and finish.** `importOrderEvidence` routes to `writer.ts` and
   `import-orders.ts`, which are deterministic and stock-neutral.
   `finishRun`, `stopForReview` and `markRunFailed` set the terminal state.
   `server/purchase-agent/run-settlement.ts` reports each operation's
   settlement through a durable Lifecycle job to `reconcileSettledRun`. Only
   the newest submission reports, once the conversation is idle, and it lists
   every queue event the agent has received. The run stays `running` while
   the server has issued a wake the agent has not received (the current
   dispatch generation, an approval decision, a Mac browser result): that
   event resumes the conversation.
6. **UI.** The Mac Browser Sync sidebar pane lists browser-enabled accounts in
   a searchable, sortable table, with live bridge status and the server sync
   plan on the same row. Rows deduplicate by account shortcode, never by
   vendor name. Sync and Resume open the returned run console before
   refreshing the advisory plan; Sync all opens Activity when it submits
   multiple runs. Partial batches retain submitted runs and raw failure/skip
   diagnostics. Replacing or disconnecting the controller invalidates pending
   sync navigation and plan reads, so late results cannot show another server’s
   accounts or open its runs.
   History import uses a per-account date-range popover. Settings retains
   browser choice and permissions, with a link to the pane. The run page proxies the agent conversation through
   `agent-proxy.ts` to the run's agent Durable Object. Member controls go
   through `controlRun` and `recordRunControlEvent`.

## Where to look

Account history may display short numeric order numbers and opaque detail URLs.
Page derivation reads ordinary anchors and single literal `location` navigation
handlers without executing JavaScript. Clickable table rows use their first
visible cell as the link label. The order classifier associates a hash-number
label with an allowlisted `/orders/<target>` link and the date following it on
the same captured row; a detail URL is not itself a history-page hint. Dynamic
handlers need browser navigation rather than a guessed URL.

| Need                                             | File                                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Queue event and bridge message shapes            | `packages/schemas/src/purchase-import.ts`                   |
| Run lifecycle, claims, and terminal states       | `run-service.ts` (search the function name from above)      |
| What the agent may call, and its inputs          | `agent-services.ts`, `server/purchase-agent/environment.ts` |
| Gmail order-mail pipeline (Workflow-backed Runs) | `gmail/` (`discovery.ts`, `search-job.ts`, `process.ts`)    |
| Statement-charge hunts                           | `hunts.ts`, `charge-runs.ts`, `charge-hunt-state.ts`        |
| Enriching imported Products (post-import, sweep) | `enrichment-sweep.ts`, `browsing-account.ts`                |
| Manual enrichment's account (preview and start)  | `targeted-run.ts` (`enrichmentAccountIds`)                  |
| Agent model, prompts, and MCP tools              | `server/purchase-agent/run-agent.ts`, `cubby-mcp.ts`        |
| Scripted/workerd harness for the agent           | `apps/web/tooling/purchase-agent-workerd-harness.ts`        |
| Its workerd runtime and `purchase-agent` profile | `apps/web/tooling/workerd-runtime.ts`, `workerd-harness.ts` |
| Billed model evals                               | `*.live-eval.ts`, `tooling/ai/eval-support.ts`              |

## Hidden dependencies

- The agent bundles `.claude/skills/purchase-import/`, `product-enrichment/`
  and `photo-inventory-import/` (each `SKILL.md` and its `references/*.md`) as
  its runtime instructions (`server/purchase-agent/import-run-workflows.ts`).
  Editing those skills changes production agent behavior.
- `signals.ts` bytes are matched by the coordinator prompt and the workerd
  scripted model; keep them stable.
- The agent mounts its purpose's MCP tools from the same compiled catalog
  the MCP server lists to it (`server/mcp/agent-tool-catalog.ts`), without
  listing them; renaming a tool or action changes both.
