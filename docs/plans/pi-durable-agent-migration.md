# Purchase agent on Agents SDK + Pi Durable; one pi-ai model layer

Status: approved 2026-10-04; breaking changes allowed (no compatibility with
in-flight Flue runs or the Flue wire protocol).

## Goal

- Replace Flue (`@flue/runtime`, `@flue/sdk`, `@flue/vite`) in
  `apps/purchase-agent` with `agents@0.26` `Agent` + `PiHarness` hosting
  `@earendil-works/pi-durable@1.0.x` on the Durable Object's SQLite.
- Replace `@tanstack/ai*` in `apps/web` with `@earendil-works/pi-ai@1.0.x`, so
  the web Worker and the agent share one model layer.
- Keep the separate agent Worker, the queue, the run-scoped MCP grant, the
  `PurchaseImportService` RPC entrypoint, and every server-side Run guard.

## Unchanged contracts

- Queue `cubby-purchase-agent` and `purchaseAgentEvent` bodies; the dispatch
  generation fence (`canDispatchCoordinator` / `acknowledgeCoordinator`).
- `PurchaseImportService` RPC methods and inputs (`purchase-agent-rpc`).
- Tool names, descriptions, input schemas, terminate semantics, and the
  `operationId`-derived idempotency keys of every typed tool.
- MCP tool names as the model sees them: `mcp__cubby__<tool>`; only the
  manifest's `mcpTools` for the run's purpose are mounted.
- Signal rendering the model sees, byte-compatible with Flue's:
  `<signal type="purchase-import.<event>" eventId="…">{json}</signal>` and the
  finish nudge `<signal type="run_not_finished">…</signal>`.
- Agent identity `importRunAgentIdentity(runId, purpose)` names the DO.

## Agent Worker design (`apps/purchase-agent`)

- `PurchaseImportRunAgent extends Agent<CloudflareBindings>` with a
  `PiHarness` capability and a `RunSettlement` capability. One DO per Run.
  Wrangler migration v2 deletes `FluePurchaseImportRunAgent`, adds the new
  SQLite class. Build stays `vite` + `@cloudflare/vite-plugin`, output
  `dist/purchase_agent` (the workerd harness reads it).
- Harness factory: pi-ai `Models` with Cubby gateway providers (shared module,
  below) using this instance's AI binding; registry with extensions
  `cubby.run` (typed tools, finish-nudge + usage/context hooks), `cubby.mcp`
  (MCP tools via `@earendil-works/pi-mcp` over the service binding, bearer
  resolved per request, never stored), `agents.skills` (the purpose's skill +
  product-enrichment). Instructions = `workflowForRun(...).instructions`.
  Model/effort from `importRunAgentManifest[purpose]`. Compaction on with
  defaults; retries `maxRetries: 3`; tool execution sequential.
- Run identity: `runId` and `purpose` stored in DO KV on first dispatch
  (`initialData`), verified against the DO name on every entry.
- One tool call per round: pi ends a run only when _every_ call of a round
  requests `terminate` (`pi-durable/dist/harness/generation.js`
  `finishToolRound`), whereas Flue settled on any terminating tool. The agent's
  gateway fetch shim sets `parallel_tool_calls: false` (Responses) /
  `tool_choice.disable_parallel_tool_use` (Messages) so a pending browser
  command can never share a round with a non-terminating call.
- MCP client: `@modelcontextprotocol/client@2.0.0` with an injected fetch
  (already ran in workerd under Flue); `pi-mcp` pulls `cross-spawn`.
- Typed tools: `replay: "safe"`; each RPC result memoized with
  `api.memo(stepKey)` (Flue `step.do`), so a replayed call returns the stored
  result; the server is idempotent by `operationId` anyway. Terminate →
  `control: { terminate: true }` plus the run doc flag.
- Finish nudge: `GenerationTask.onYield` returns `{ continue }` with the
  signal text when the purpose has a nudge and the tool-call count advanced
  since the last nudge. `onYield` only runs on a final answer, never after a
  terminating round, so Flue's "settled by tool" flag disappears. Hook memos
  are per generation task (one per turn), so the counter (`afterTools`
  increments) and last-nudged count live in the DO's own KV storage.
- Usage: `GenerationTask.afterResponse` → `recordAgentUsage` (eventId from
  `responseId`/entry, provider, model, tokens, cost, gateway log id captured by
  the fetch shim) and stores the per-call context breakdown in a DO table
  `cubby_context_calls(response_id, breakdown)`.
- Settlement: after each queue/prompt submission, push a lifecycle job
  `settle:<operationId>`. `onJob` reads `harness.pending()`; while pending it
  reschedules (+10 s); once settled, `done` → `reconcileSettledRun`,
  `unanswered` → `markRunFailed` (`agent_aborted` when aborted, else
  `agent_failed`) + review progress. Bounded dispatch, durable across
  eviction. "Coordinator started" progress is posted at submit.
- Queue consumer: unchanged fence/ack logic; delivery =
  `getAgentByName(env.PurchaseImportRunAgent, agentId).dispatch(event)` RPC,
  which stores identity, renders the signal, and `submit(..., { operationId:
idempotencyKey })`. Browser signals use `whenBusy: "steer"`.
- HTTP (behind the existing internal path + header marker):
  `GET /` → conversation snapshot (Cubby schema), `GET /stream` → SSE of
  snapshots (initial + after each commit, coalesced), `POST /` `{kind:"user",
body}` → steer/follow-up with a fresh operation id, `POST /abort`.
- Observability: native Workers Traces via `@cubby/worker-tracing` spans;
  Sentry via `instrumentDurableObjectWithSentry` on the agent class and
  `withSentry` on the Worker; report errors from settlement and pi `onReport`.
  No message or tool content in spans or logs.

## Conversation contract (`packages/schemas/src/agent-conversation.ts`)

Zod schema owned by Cubby, produced by the agent from pi entries + `pi.live`:
`{ phase: "absent"|"idle"|"live", messages: Message[], settlements:
{operationId, outcome}[] }`, `Message = { id, role: "user"|"assistant"|"signal",
purpose, display, signal?: {type, attributes}, settlement?: {outcome},
metadata?: { usage?, contextBreakdown? }, parts: Part[] }`, `Part = text |
reasoning | file{filename?, mediaType} | tool{toolName, state:
"input-available"|"output-available"|"output-error", input, output?,
errorText?, durationMs?}`. The web proxy redaction stays. The web client
(`agent-observation.ts`, run detail, work summary, context breakdown) consumes
it with an SSE `EventSource`-style reader and fetch for prompt/abort.

## Web model layer

- `packages/shared/src/pi-gateway.ts`: shared Cubby model rows (OpenAI
  Responses GPT-6 synthesized from pi templates, Anthropic, compat
  Gemini via openai-completions) as pi-ai providers whose fetch is injected.
  Agent injects the AI-binding `gateway.run` shim; web injects `gatewayFetch`.
- `run-feature.ts`: one forced, strict JSON-schema `respond` tool from
  `z.toJSONSchema(spec.schema)`; parse `toolCall.arguments` with the schema;
  same repair turn; usage recorded from `AssistantMessage.usage` (one writer);
  gateway exact-body cache dropped (the application response cache already
  covers every cached feature). Images resolved URL→base64.
- Embeddings: direct `gatewayFetch("openai")` POST `/embeddings`.
- `jev.ts` is untouched (already a raw gateway call).
- Test gateway peer answers the forced tool call instead of output text.

## Also touched

- `apps/web/tooling/dev/config.ts` (local dev ran the agent through the Flue
  Vite plugin; switch to the agent's own Wrangler config + migration tag),
  `knip.json`, `purchase-agent-rpc` `failureCode` → `agent_failed` /
  `agent_aborted` (stored rows keep old strings; the column is free text), dev
  scenarios/smoke assertions, web proxy `allowedSuffix` (`stream`, drop
  `attachments/*`).

## Lanes

Claude host only (no Codex hand-off). Lanes edit disjoint files in this one
worktree; shared files (`pnpm-lock.yaml`, `package.json`s) are edited by main.

- Main (opus/medium): shared pi gateway module, conversation schema, agent
  Worker, dev tooling, docs, integration + final validation, PR.
- Lane W (sonnet/medium): web TanStack removal — `server/ai/*`,
  `server/clients/ai*.ts`, `structured-output-adapter.ts`, `embeddings.ts`,
  `image-description.service.ts`, `agents/purchase-import/*`, test gateway
  peer, their unit tests, `@tanstack/ai*` deps. Depends on the shared module.
- Lane C (sonnet/medium): web agent client — `app/runs/agent-observation.ts`,
  `app/purchases/*agent*`, `purchase-import-run-detail.tsx`,
  `lib/agent-context-breakdown.ts`, their tests, `@flue/sdk` dep. Depends on
  the conversation schema.

## Validation

- Agent: typecheck, unit tests for signal rendering, settlement mapping,
  projection; `pnpm --dir apps/purchase-agent build`.
- Coupled workerd suites (`purchase-agent-workerd`, `purchase-agent-scenarios`
  integration tests) — the recovery/approval/cancellation regressions.
- Web: `pnpm test:file` for touched unit tests; typecheck, lint, knip in CI.

## Production cutover

Breaking: deploy drains nothing. Before deploy, terminalize Runs whose
coordinator is active (`running`/`paused_*`); the old Flue DO class is deleted
by migration v2.
