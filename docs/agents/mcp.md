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

For files, `image.create_file_upload({items})` accepts up to 50 existing upload
inputs and returns results in item order. Upload local bytes to each returned
presigned URL, then call `image.attach_file({items})` with each target `entityId`
and exactly one `url` or the uploadId from that successful indexed result. Do
not send bytes or base64 through MCP. For a Product gallery write, read the
target immediately before the write and provide its `expectedImageCount` and a
deterministic idempotency key. Multiple attachments to one Product are
dependent count changes; prefer independent target batches and retry only
failed items after a fresh read.

A generated tool takes `{action, input}`. When that operation also accepts an
`action`, MCP publishes it as `operationAction` inside `input` and maps it back
before validation; for example, `activity.resolve_run_finding` requires
`input.operationAction: "apply" | "dismiss"`. Batched items retain their own
nested `action` field. HTTP and native operation inputs keep their original
shape. The `entity` and `entity_read` kernel tools keep their current
`{action, ...fields}` form; their full schemas are available from
`entities://catalog`.

## Runs and Burn-down

Run-delegated mutations execute permitted writes without a separate approval.
Reuse an operation ID only with the identical tool and arguments: a completed
operation returns its saved result even after its Run stops. New writes remain
fenced by the Run's current state.

Runs are started by Mail discovery (scheduled, or `run.discover_mail` on the
member's instruction), photo uploads and a member's own
`purchase_import.prepare`; nothing else on MCP starts research
([ADR 0010](../adr/0010-mail-import-unattended-burn-down-interactive.md)).
`run.work_snapshot` reads one Run. An owned `mail_discovery` Run includes
`mailDiscovery`: its frozen mailbox scope, persisted Workflow checkpoint,
current mailbox coverage, recorded AI-call usage/retries and failure diagnostics.
Current mailbox coverage can advance after that Run; the Workflow checkpoint
belongs to that Run. Unpriced calls remain counted. Missing checkpoint/coverage
stays null. Query lists are summarized (counts plus the first or next pending
queries) and an in-flight page reads as message/event counts, so a status read
stays bounded however many searches a mailbox has. `run.mail_import` reads each connected mailbox's Mail import
switch and search progress; `ai_funding.status` reads household-wide
frontier AI funding (the window's Claude credit, including a recorded
Anthropic refusal, paid budget and ChatGPT plan). These reads never
load or resume a Workflow. Discovery has no coordinator conversation, so its owned
`run.transcript` returns `absent`; that is not evidence it never ran.
`run.lifecycle` runs every Run control
(cancel, retry, restart, approve, reject and the rest). File-import cancellation
does not require an agent session and retains already committed imports.
Abandoned non-agent imports fail under the existing inactivity policy; live
activity prevents expiry and late writes cannot revive terminal Runs. Review and spending
decisions are reachable on MCP too
(`run.set_mail_import`, `run.discover_mail`, `run.commit_prepared`,
`ai_funding.set_credit_budget`, `ai_funding.reset_credit_refusal`,
`activity.resolve_run_finding`, `photo_run.approve_groups`,
`product_enrichment.merge_product_match`, suggestion review: `suggestions.review`,
`suggestions.review_batch`, each batch returning a per-id `ok`/`error`
result). An agent calls one only
on the member's explicit instruction. An exact-checksum member-selected Email
import using the declared coordinator models or its member-controlled retry is
foreground work outside the AI budget. Explicit member selections of Vendor
order Emails use the same policy within the existing selection limit. Other
frontier chat-model calls draw from the household AI budget, a stopgap safety
net ([import journey](../guide/import-journey.md)).
No run purpose holds the `start_run` or `member_decision` capability
(`server/domains/purchase-import/repo/capabilities.ts`), so a coordinator never starts
another run or makes a member's decision. That gate applies only to
Run-delegated tokens: a member OAuth session, including an automated routine
holding a member token, can call every `member_decision` write.

Burn-down works the Research queue (`research-queue` saved views) with the
caller's own browser. Retain research in ordinary editable `notes` inside
entity mutation `data`: preserve existing text, useful URLs or record shortcodes,
excerpts, dates and selected-variant context. There is no separate citation input
on entity writes or image attachment, and notes do not certify current values.
Read and resolve retained
Email with `purchase_import.mail_read` and `purchase_import.mail_resolve`; recover a missing original
with `purchase_import.mail_search`. The retained read's `acceptedSourceOrders` provides owned
source-order handles, exact source identities and deleted-target status for
reviewed reconciliation. Lifecycle-only links supply no accepted-order handle;
reading one neither promotes an unknown original nor authorizes its repair.
A member's search runs no paid classification: past Spam
and Trash every match is retained as `uncertain`, and the caller settles each
with `purchase_import.mail_resolve` (`unrelated` disposes of it). Change identifier slots with `entity.update` collection
patches on `externalIds` (`{op: "add"|"replace"|"remove", key, value?, expect?}`).
Record "searched, not available" with `data_exception.set_exception`.

Photo MCP identifiers follow the same entity boundary: `runId`, `productId`
and photo `id` values are canonical shortcodes. The one
`photo_run.reject_candidate` `operationId` is a caller-generated retry key, not
an entity reference. Its owning `rejectCandidate` declaration in
`apps/web/src/contracts/photo-import.contract.ts` describes that protocol;
`rejectPhotoProductCandidate` scopes it to each photo's Assessment review.
Reuse the key only for the identical rejection, not a different decision.

`photo_run.run_context` serves the bounded per-photo text assembled by
`photo-import/operations/photo-import.server.ts:runContext`. Its
`photoRunContextImage` schema must match that summary: it does not expose the
richer web/native `photoRunImage.descriptionEvidence`. The Image shortcode
remains the public reference; retained `AiAnalysis` rows are not addressable
entities or new MCP identifier exceptions.

## Failures and timeouts

Published input schemas keep an object root and share repeated nested fields
through definitions, including small constrained workflow fields. Measure the
whole catalog when tuning sharing: reference overhead can exceed the saving,
and validation plus model-facing descriptions must survive.
Any change to a tool's input schema or its `.describe`
text, including a shared Zod schema a tool imports, runs
`pnpm test:postgres src/server/mcp/catalog.integration.test.ts` and the
`mcp-contract` project before push: the budget and uuid-boundary checks live
there, not in typecheck. When a change exceeds the catalog size budget,
reduce repeated schema text without dropping validation or raising the budget.
Source-order reconciliation preparation belongs to the mutating `purchase_import`
tool because it persists the reviewed fingerprint and may promote a validated
historical observation; it changes no ledger or stock.

A tool failure comes back as an `isError` result whose text names the cause
and whose `_meta["cubby/error"]` carries `code`, `reason`, `requestId`, and
`diagnostics` (operation, stage, causes, `cfRayId`, Sentry link). An output
that fails its own schema is `INVALID_OUTPUT` and names each failing path.

Every call has a wall-clock budget (`MCP_TOOL_DEADLINE_MS` in
`apps/web/src/server/mcp/tools/tool-registration.ts`): 18 s for reads, 45 s
for reads that declare `modelBacked` (the decision model's 30 s retry budget plus database
work), and 230 s for writes. An action that can wait on the decision model or another model
declares `modelBacked: true` on its contract member; today
those are `entity_read.preview`, `ai.suggest_fields`,
`entity_graph.discover` and `purchase_import.mail_triage_preview`. Past its budget the call answers
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

Every query and mutation resolves one `exposure`, either from its member or the
contract default. `capability` means supported household work and is available
to MCP; `view` means a client-facing read model/helper and stays off MCP;
`internal` means transport, auth, or protocol plumbing and stays off MCP.
Subscriptions are exempt. `pnpm generate` fails if an operation has no exposure
or a capability lacks its agent-facing `description`.

Capability actions and their snake_case member names are generated into MCP
tools. A contract's `mcpToolGroup` groups its actions; otherwise its domain name
is converted to snake_case. `contracts/mcp-tools.ts` contains only entity-kernel
actions, optional per-operation MCP shaping, and tool descriptions. Destructive,
open-world and model-backed behavior hints live on the contract member.

Generated tools use progressive disclosure: their published schema names the
available action and accepts a compact `input` object. Call `describe` with
`input.actions` to retrieve selected actions' full input/output JSON Schema and
description. The server validates each request against the action's full Zod
schema. The entity-kernel tools keep their detailed schemas because
`entities://catalog` already publishes the precise action schemas.

A write's review handle (suggestion id, fingerprint, event id, finding id) must
be produced by a capability read; when the producer cannot be exposed, defer
the write too. A person's review or approval remains a member decision and must
be gated by the `member_decision` capability. Update any active backlog item
when its remaining work changes.

## Playbooks

The household skills in `PLAYBOOK_SKILLS` (`apps/web/generator/playbooks.ts`)
ship with the Worker so every connected client follows the deployed rules:
the read-only `playbook` tool (`list`, `get`, `read`) and one
`skill://<name>/<path>` resource per file. The generator bundles each skill's
Markdown plus every repository Markdown file it links to, rewrites served
links to repository paths and other links to public GitHub URLs, and fails on
a link that does not resolve. Engineering skills stay repository-only.

The repository is also a Claude plugin marketplace
(`.claude-plugin/marketplace.json` → `plugins/cubby`). Its skills are pointer
stubs that call `playbook.get`, so they change only when a playbook's name or
description does. Regenerate and commit them with
`pnpm --dir apps/web generate:claude-plugin` in the same change as that metadata;
ordinary generation leaves these committed stubs alone. `claude-plugin.test.ts`
detects drift. The plugin declares no MCP server:
each member adds the Cubby connector once. A member adds the marketplace in
claude.ai under Customize › Plugins › Add marketplace (`nickysemenza/cubby`)
with Sync automatically on; claude.ai plugins sync into Claude Code.
