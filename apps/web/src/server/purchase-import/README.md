# Purchase import: how a Run moves between Workers

A purchase-import Run spans two Workers and a Mac browser. The web Worker owns
every write. The purchase agent (`apps/purchase-agent`) owns only the model
conversation and has no database or browser binding.

## One Run, end to end

1. **Start.** `targeted-run.ts` (`startTargetedImport`, `dispatchStartedRun`)
   commits the Run and sends a `start_or_resume` event to the
   `PURCHASE_AGENT_QUEUE` (`cubby-purchase-agent`). A failed send is recorded
   as `dispatch_failed` and is never thrown.
2. **Coordinator.** `apps/purchase-agent/src/cloudflare.ts`
   (`consumePurchaseAgentQueue`) wakes the per-Run `PurchaseImportRunAgent`
   (`run-agent.ts`, `dispatch`). Queue events reach the model as
   `<signal type="…">` user text (`signals.ts`).
3. **Tools call back to web.** Agent tools (`apps/purchase-agent/src/tools.ts`)
   call the `CUBBY_PURCHASE_SERVICE` service binding. The binding is typed by
   the interface in `apps/purchase-agent/src/service.ts` and implemented by
   `PurchaseImportService` in `apps/web/src/cf-server.ts`. Each method there is
   a thin wrapper around a same-named function in `run-service.ts`.
4. **Browser commands.** `issueBrowserCommand` (in `run-service.ts`) enqueues
   on the bridge Durable Object (`durable-object.ts`,
   `PurchaseImportDurableObject`, one per vendor account). The Mac connects
   through `direct-socket-route.ts`. A Mac result publishes a `browser_result`
   event to the same queue, a reconnect publishes `browser_connected`, and the
   agent then calls `readBrowserCommandResult`.
5. **Writes and finish.** `importOrderEvidence` routes to `writer.ts` and
   `import-orders.ts`, which are deterministic and stock-neutral.
   `finishRun`, `stopForReview` and `markRunFailed` set the terminal state.
   `run-settlement.ts` (agent side) reports each operation's settlement through
   a durable Lifecycle job to `reconcileSettledRun`.
6. **UI.** The run page proxies the agent conversation through `agent-proxy.ts`
   to the agent's internal route (`apps/purchase-agent/src/internal-agent-route.ts`).
   Member controls go through `controlRun` and `recordRunControlEvent`.

## Where to look

| Need                                       | File                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| Queue event and bridge message shapes      | `packages/schemas/src/purchase-import.ts`              |
| Run lifecycle, claims, and terminal states | `run-service.ts` (search the function name from above) |
| Gmail order-mail pipeline (hourly cron)    | `gmail/` (`hourly.ts`, `process.ts`, `import.ts`)      |
| Statement-charge hunts                     | `hunts.ts`, `charge-runs.ts`, `charge-hunt-state.ts`   |
| Agent model, prompts, and MCP tool cache   | `apps/purchase-agent/src/run-agent.ts`, `cubby-mcp.ts` |
| Scripted/workerd harness for the agent     | `apps/web/tooling/purchase-agent-workerd-harness.ts`   |
| Billed model evals                         | `*.live-eval.ts`, `agent-eval-live-support.ts`         |

## Hidden dependencies

- The agent bundles `.claude/skills/purchase-import/`, `product-enrichment/`
  and `photo-inventory-import/` (each `SKILL.md` and its `references/*.md`) as
  its runtime instructions (`apps/purchase-agent/src/import-run-workflows.ts`).
  Editing those skills changes production agent behavior.
- `signals.ts` bytes are matched by the coordinator prompt and the workerd
  scripted model; keep them stable.
- `PurchaseImportService` method names must match the agent's
  `PurchaseImportService` interface. The binding is cast, not checked.
