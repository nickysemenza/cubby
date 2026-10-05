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
6. **UI.** The run page proxies the agent conversation through
   `agent-proxy.ts` to the run's agent Durable Object. Member controls go
   through `controlRun` and `recordRunControlEvent`.

## Where to look

| Need                                             | File                                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Queue event and bridge message shapes            | `packages/schemas/src/purchase-import.ts`                   |
| Run lifecycle, claims, and terminal states       | `run-service.ts` (search the function name from above)      |
| What the agent may call, and its inputs          | `agent-services.ts`, `server/purchase-agent/environment.ts` |
| Gmail order-mail pipeline (hourly cron)          | `gmail/` (`hourly.ts`, `process.ts`, `import.ts`)           |
| Statement-charge hunts                           | `hunts.ts`, `charge-runs.ts`, `charge-hunt-state.ts`        |
| Agent model, prompts, and MCP tools              | `server/purchase-agent/run-agent.ts`, `cubby-mcp.ts`        |
| Scripted/workerd harness for the agent           | `apps/web/tooling/purchase-agent-workerd-harness.ts`        |
| Its workerd runtime and `purchase-agent` profile | `apps/web/tooling/workerd-runtime.ts`, `workerd-harness.ts` |
| Billed model evals                               | `*.live-eval.ts`, `agent-eval-live-support.ts`              |

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
