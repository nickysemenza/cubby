# MCP operating patterns

The [README entity map](../../README.md#entities) says which entity holds what
and how they relate; check it before choosing a tool.

Read summaries and counts first. Narrow list reads with filters, page only as
needed, and use `ids` filters for known records. Read tool input schemas first;
consult the catalog only when they do not answer a required field or action.

Use `entity.commands` for independent creates or updates after their dependencies
are resolved. Its results are ordered and independent: inspect every result,
keep successful writes, and retry only corrected failed indices. Verification
is likewise batched by known ids or shared filters.

For files, `image.create_uploads({items})` accepts up to 50 existing upload
inputs and returns results in item order. Upload local bytes to each returned
presigned URL, then call `image.attach_files({items})` with each target `entityId`
and exactly one `url` or the uploadId from that successful indexed result. Do
not send bytes or base64 through MCP. For a Product gallery write, read the
target immediately before the write and provide its `expectedImageCount` and a
deterministic idempotency key. Multiple attachments to one Product are
dependent count changes; prefer independent target batches and retry only
failed items after a fresh read.

## Runs and Burn-down

Runs are started by Mail discovery, photo uploads and a member's own
`purchase_import.prepare`; nothing on MCP starts research
([ADR 0008](../adr/0008-mail-import-unattended-burn-down-interactive.md)).
`imports_read.run_status` reads one Run; `run.lifecycle` cancels, retries or
restarts it. No run purpose holds the `start_run` capability
(`server/purchase-import/capabilities.ts`), so a coordinator never starts
another run.

Burn-down works the Research queue (`research-queue` saved views) with the
caller's own browser. Record where each fact was seen with `sources` on
`entity.update` (field-scoped) and `image.attach_files` (record-level); a
quote and URL are enough, screenshots are optional. Read and resolve retained
Email with `imports_read.mail` and `mail.resolve`; recover a missing original
with `mail.search`. A member's search runs no paid classification: past Spam
and Trash every match is retained as `uncertain`, and the caller settles each
with `mail.resolve` (`unrelated` disposes of it). Change identifier slots with `entity.update` collection
patches on `externalIds` (`{op: "add"|"replace"|"remove", key, value?, expect?}`).
Record "searched, not available" with `data_exception.set`.

## Failures and timeouts

A tool failure comes back as an `isError` result whose text names the cause
and whose `_meta["cubby/error"]` carries `code`, `reason`, `requestId`, and
`diagnostics` (operation, stage, causes, `cfRayId`, Sentry link). An output
that fails its own schema is `INVALID_OUTPUT` and names each failing path.

Every call has a wall-clock budget (`MCP_TOOL_DEADLINE_MS` in
`apps/web/src/server/mcp/tools/tool-registration.ts`): 18 s for reads, 45 s
for reads that declare `modelBacked` (Jev's 30 s retry budget plus database
work), and 230 s for writes. An action that can wait on Jev or another model
declares `modelBacked: true` in `apps/web/src/contracts/mcp-tools.ts`; today
that is `entity_read.preview`. Past its budget the call answers
`MCP_TOOL_DEADLINE_EXCEEDED` with the elapsed time, request id, and Sentry event id, logs a
warning, and reports to Sentry. The deadline aborts the call's `signal`, which
stops AI and upstream fetches but not Postgres queries or kernel verbs. Work
that settles after the answer is dropped. Narrow a timed-out read. A timed-out
write may still have committed: re-read the affected records before retrying.

The HTTP ingress (`apps/web/src/server/mcp/http-handler.ts`) authenticates from
headers before it reads any body, then reads the body once under the SDK's
4 MiB limit; a larger body is refused with JSON-RPC `-32600` (HTTP 413) without
being buffered. A throw that escapes the SDK, including a failed body read,
answers a JSON-RPC `-32603` error that echoes the request id and names the tool
and action, the cause, the elapsed time, the Cubby request id, and the Sentry event id when one was captured, with
write-retry guidance for writes. The message and `error.data` are scrubbed of
credential-shaped values. A Worker killed by a platform limit (a synchronous
CPU loop, memory) still sends no body; the connector shows that only as
"Invalid content from server". Find it in Cloudflare observability by time,
then narrow or speed up the call.

## Exposure

Every `query()` and `mutation()` contract member is either named by an action
in `apps/web/src/contracts/mcp-tools.ts` or declares why not with
`mcp: { omit }` (`mcpOmission` in `apps/web/src/contracts/define.ts`), never
both; `pnpm generate` fails otherwise. Subscriptions are exempt. Declare the
reason on the member itself — there is no contract-level default — and add a
`note` when the reason alone does not say why.

- `agent_twin` names the exposed operation (`twin`) agents call instead.
- `kernel_alternative` names the entity-kernel verbs (`kernel`) that can do the
  work, with a `note` on how. It records an omission, not proven parity.
- `deferred_capability` is real agent work not yet exposed: `todo` names the
  [todos](../todos.md) entry, which must list the operation id.
- `client_view`, `model_assist`, `human_approval`, `upload_transport`,
  `device_protocol`, `auth_connection`, and `operator_maintenance` are the
  closed reasons agents do without it.

Exposing an operation means adding its action and deleting its `mcp`
declaration (and its todo line when deferred). A member input publishes as an
object, an optional object, a union of objects, or no input; a tool's
actions are all queries or all mutations, so an operation's reads and writes
land in different tools.
