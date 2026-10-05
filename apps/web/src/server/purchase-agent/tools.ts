import { purchaseAgentToolInputs } from "@cubby/schemas/purchase-agent-services";
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import type { RunServices } from "./environment";

type ToolInputs = typeof purchaseAgentToolInputs;
type ToolName = keyof ToolInputs;

/** The lifecycle fields of a browser command result. */
const browserCommandState = z.looseObject({
  status: z.string().optional(),
  state: z.string().optional(),
});

function pendingResult(result: JsonValue): boolean {
  const parsed = browserCommandState.safeParse(result);
  return (
    parsed.success &&
    (parsed.data.status === "pending" ||
      parsed.data.state === "pending" ||
      parsed.data.state === "dispatched" ||
      parsed.data.state === "paused_auth" ||
      parsed.data.state === "paused_offline")
  );
}

/**
 * One service effect per step key. The first completion is memoized on the tool
 * task, so a call replayed after an eviction returns the stored result instead
 * of repeating the effect; the server is idempotent by operation id as well.
 */
async function step(
  api: ToolExecutionApi,
  context: Context,
  key: string,
  effect: () => Promise<object | null>,
): Promise<JsonValue> {
  const stored = await api.memo<{ value: JsonValue }>(key, context);
  if (stored) return stored.value;
  const value = z.json().parse(await effect());
  return (await api.memo(key, { value }, context)).value;
}

function result(output: JsonValue, terminate = false): ToolExecutionResult {
  const content = [{ type: "text" as const, text: JSON.stringify(output) }];
  if (!terminate) return { content };
  return { content, control: { terminate: true } };
}

type JsonSchema = z.core.JSONSchema._JSONSchema;

/**
 * A contract's JSON Schema rebuilt from TypeBox builders, every other keyword
 * kept as is. pi converts a call's arguments with TypeBox `Value.Convert`
 * before validating, and that sees only TypeBox-built nodes: behind
 * `Type.Unsafe` pi's narrower coercion refused a model's `"TRUE"` or `"0"`
 * for a boolean. A shape this does not know fails when the tools are built.
 */
function typeboxSchema(node: JsonSchema): TSchema {
  if (node === true || node === false)
    throw new Error("Unsupported boolean schema");
  const { type, properties, required, items, ...options } = node;
  switch (type) {
    case "object":
      return Type.Object(
        Object.fromEntries(
          Object.entries(properties ?? {}).map(([key, value]) => {
            const property = typeboxSchema(value);
            return [
              key,
              required?.includes(key) ? property : Type.Optional(property),
            ];
          }),
        ),
        options,
      );
    case "array":
      if (items === undefined || Array.isArray(items))
        throw new Error("Unsupported array schema");
      return Type.Array(typeboxSchema(items), options);
    case "string":
      return Type.String(options);
    case "boolean":
      return Type.Boolean(options);
    case "number":
    case "integer": {
      // Draft-7 exclusive bounds are numbers; only draft-04's are booleans.
      const { exclusiveMinimum: min, exclusiveMaximum: max, ...rest } = options;
      const bounds = {
        ...rest,
        ...(min !== undefined && { exclusiveMinimum: z.number().parse(min) }),
        ...(max !== undefined && { exclusiveMaximum: z.number().parse(max) }),
      };
      return type === "number" ? Type.Number(bounds) : Type.Integer(bounds);
    }
    default:
      throw new Error(`Unsupported tool schema ${JSON.stringify(node)}`);
  }
}

/**
 * One typed tool: its contract's JSON Schema is what the model sees and what
 * pi validates the call against before `execute`.
 */
function tool<N extends ToolName>(
  name: N,
  definition: {
    description: string;
    execute: (
      args: z.input<ToolInputs[N]>,
      api: ToolExecutionApi,
      context: Context,
    ) => Promise<ToolExecutionResult>;
  },
) {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(
    purchaseAgentToolInputs[name],
    { target: "draft-7", io: "input" },
  );
  return defineTool<TSchema>({
    name,
    // Non-strict, like the MCP tools in `cubby-mcp.ts`: pi-ai
    // `structuredClone`s strict tool parameters (see `ai/run-feature.ts`).
    parameters: typeboxSchema(schema),
    // Every typed tool is replay-safe: its effects are memoized steps keyed
    // by the model's operation id.
    replay: "safe",
    ...definition,
  });
}

/**
 * Typed run services are deliberately limited to seams that cannot travel
 * through MCP: browser commands must end the run while the user's browser
 * works, progress must be visible before another model turn completes, and
 * lifecycle transitions stay behind the host's crash-safe guards.
 *
 * A terminating tool ends the run only when it is the round's sole call; the
 * agent's transport disables parallel tool calls so that always holds.
 */
export function purchaseImportTools(
  services: () => RunServices,
): ToolRegistration[] {
  return [
    tool("claim_next_import_work", {
      description:
        "Claim and describe the run's next bounded work item. Use this before choosing saved mail, receipt or browser evidence work, and again after each committed item. For settlement_verification, verify the named existing Purchase against saved statement evidence, then finish or stop for review rather than claiming this item repeatedly. Otherwise continue until none.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `claim-work:${args.operationId}`, () =>
            services().claimNextWork(args),
          ),
        ),
    }),
    tool("extract_receipt_evidence", {
      description:
        "Run Cubby's bounded receipt extractor for the receipt assigned to this run. Its returned immutable source, checksum, extraction, image id, and stable ids are the input to purchase_import.prepare.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `extract-receipt:${args.operationId}`, () =>
            services().extractReceiptEvidence(args),
          ),
        ),
    }),
    tool("extract_run_evidence", {
      description:
        "Extract the saved confirmation assigned to mail_evidence work, or immutable uploaded evidence for a purchase validation target. Pass the returned source, checksum, extraction, revision and stable ids unchanged to purchase_import.prepare. Use this instead of a shared Image or document API.",
      execute: async (args, api, context) =>
        result(
          await step(
            api,
            context,
            `extract-run-evidence:${args.operationId}`,
            () => services().extractRunEvidence(args),
          ),
        ),
    }),
    tool("issue_browser_command", {
      description:
        "Request one fixed read-only browser action. A pending command ends this submission; a queue event resumes this same agent when evidence is ready.",
      execute: async (args, api, context) => {
        await step(api, context, `browser-progress:${args.operationId}`, () =>
          services().updateAgentProgress({
            eventId: `browser-progress:${args.operationId}`,
            phase: "awaiting_browser",
            currentItem: args.command.target,
            detail: args.command.kind,
          }),
        );
        const output = await step(
          api,
          context,
          `browser-command:${args.operationId}`,
          () =>
            services().issueBrowserCommand({
              operationId: `browser-command:${args.operationId}`,
              command: args.command,
            }),
        );
        return result(output, pendingResult(output));
      },
    }),
    tool("read_browser_command_result", {
      description:
        "Read the persisted result for a browser command. A pending result ends this submission; do not poll it.",
      // Deliberately not a memoized step: a stored pending answer would hide
      // the completed result the resumed agent comes back to read.
      execute: async (args) => {
        const output = z.json().parse(
          (await services().readBrowserCommandResult({
            operationId: `browser-command:${args.operationId}`,
          })) ?? null,
        );
        return result(output, pendingResult(output));
      },
    }),
    tool("import_browser_order_evidence", {
      description:
        "Bind a completed browser command's retained evidence to its exact run target before preparation or enrichment. Use the commandId returned by the browser result. For an order page, pass defaultTrade (and defaultProjectId when known) exactly as for purchase_import.commit: a principal line without a trade from its Purchase or Project is refused.",
      execute: async (args, api, context) =>
        result(
          await step(
            api,
            context,
            `import-browser-evidence:${args.operationId}`,
            () => services().importOrderEvidence(args),
          ),
        ),
    }),
    tool("report_agent_progress", {
      description:
        "Publish the current import phase for the live run UI. Set awaitingApproval when a Cubby tool requires a human decision; approval and review phases end this submission.",
      execute: async (args, api, context) => {
        await step(api, context, `agent-progress:${args.operationId}`, () =>
          services().updateAgentProgress({
            eventId: `agent-progress:${args.operationId}`,
            phase: args.phase,
            currentItem: args.currentItem,
            awaitingApproval: args.awaitingApproval,
            detail: args.detail,
          }),
        );
        // A `review` report ends the run's submission, so it must also move
        // the run: a progress row alone left runs `running` with no
        // coordinator behind them.
        if (args.phase === "review")
          await step(
            api,
            context,
            `agent-progress-review:${args.operationId}`,
            () =>
              services().stopForReview({
                operationId: `agent-progress-review:${args.operationId}`,
                reason: "other",
                detail: args.detail,
              }),
          );
        return result(
          { recorded: true, phase: args.phase },
          args.phase === "awaiting_approval" || args.phase === "review",
        );
      },
    }),
    tool("save_navigation_hints", {
      description:
        "Persist observed vendor navigation hints. The server accepts only URLs inside the vendor's existing browser allowlist; this tool cannot expand browser authority.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `navigation-hints:${args.operationId}`, () =>
            services().saveNavigationHints(args),
          ),
        ),
    }),
    tool("mark_history_expired", {
      description:
        "Record the earliest order timestamp the vendor still exposes after the bounded history scan proves older orders are unavailable.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `history-expired:${args.operationId}`, () =>
            services().markHistoryExpired(args),
          ),
        ),
    }),
    tool("finish_import_run", {
      description:
        "Complete the run only after every selected order or hunt is resolved or explicitly exhausted. The server refuses pending hunts and enforces all required audit batches before completion.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `finish-run:${args.operationId}`, () =>
            services().finishRun(args),
          ),
          true,
        ),
    }),
    tool("stop_import_run_for_review", {
      description:
        "Stop on ambiguous or unreadable evidence without speculative writes. The server creates one run-scoped finding, runs required audits, fences the run, and records needs_review.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `stop-review:${args.operationId}`, () =>
            services().stopForReview(args),
          ),
          true,
        ),
    }),
    tool("defer_order_for_review", {
      description:
        "Leave one listed order from this account-sync worklist for human review when its evidence stays ambiguous or unreadable, then continue with the remaining orders. The server records one finding naming the order and marks it skipped; the run then ends in review instead of claiming a complete import.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `defer-order:${args.operationId}`, () =>
            services().deferOrderForReview(args),
          ),
        ),
    }),
    tool("settle_charge_hunt", {
      description:
        "Record the outcome of one statement charge this run was asked to find, when importing evidence did not settle it. Use not_found after searching the vendor account for the charge's amount and date window without a matching order; use needs_review when a candidate order exists but stays ambiguous or unreadable. The server records the outcome for that one charge and the run continues with the remaining charges; it then ends in review instead of claiming a complete import. A charge the server already settled is recorded as resolved.",
      execute: async (args, api, context) =>
        result(
          await step(
            api,
            context,
            `settle-charge-hunt:${args.operationId}`,
            () => services().settleChargeHunt(args),
          ),
        ),
    }),
  ];
}
