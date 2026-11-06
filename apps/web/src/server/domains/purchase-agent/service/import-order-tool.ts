import { EXTRACT_ORDER_TOOL } from "@cubby/schemas/import-run-agent";
import {
  mailMessageRef,
  MAIL_READ_RESPONSE_MAX_BYTES,
} from "@cubby/schemas/mailbox-research";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  preparedProductResolution,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type NestedToolExecutionResult,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import type { MailAttemptEvidence } from "./mail-attempts";

const orderFields = preparePurchaseImportInput.shape.orders.element.shape;
const input = z
  .object({
    mail: mailMessageRef.extend({ checksum: orderFields.evidenceChecksum }),
    vendorId: orderFields.vendorId,
    vendor: orderFields.vendor,
    targetPurchaseId: orderFields.targetPurchaseId,
    defaultTrade: commitPurchaseImportInput.shape.defaultTrade,
    defaultProjectId: commitPurchaseImportInput.shape.defaultProjectId,
    extraction: orderFields.extraction,
    products: z
      .array(preparedProductResolution.nullable())
      .max(500)
      .describe(
        "One Product decision per extracted line, in order. Use null for non-principal lines; never guess an existing Product or use expense_only for goods.",
      ),
  })
  .superRefine((value, context) => {
    const lines = value.extraction.candidate?.lines ?? [];
    if (value.products.length !== lines.length)
      context.addIssue({
        code: "custom",
        path: ["products"],
        message: "Supply one Product decision (or null) per extracted line.",
      });
  });

const output = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit_result"),
    result: commitPurchaseImportOut,
    nextWork: z.json().optional(),
  }),
  z.object({
    kind: z.literal("needs_resolution"),
    preparation: preparePurchaseImportOut,
  }),
  z.object({ kind: z.literal("incomplete"), reason: z.string() }),
  z.object({
    kind: z.literal("operation_error"),
    stage: z.enum(["prepare", "commit"]),
    operationId: z.string(),
    diagnostic: z.string(),
  }),
]);

function nestedValue<S extends z.ZodType>(
  result: NestedToolExecutionResult,
  schema: S,
) {
  if (typeof result.structuredOutput !== "string")
    return schema.safeParse(result.structuredOutput);
  try {
    return schema.safeParse(JSON.parse(result.structuredOutput));
  } catch {
    return schema.safeParse(undefined);
  }
}

/** Pi supplies source facts once; code owns IDs, preparation and publication. */
export function importExtractedOrderTool(
  runId: string,
  ordinaryEvidence: () => MailAttemptEvidence | undefined,
) {
  const { $schema: _inputDialect, ...parameters } = z.toJSONSchema(input, {
    target: "draft-7",
    io: "input",
  });
  const { $schema: _outputDialect, ...resultSchema } = z.toJSONSchema(output, {
    target: "draft-7",
  });
  return defineTool({
    name: EXTRACT_ORDER_TOOL,
    description:
      "Import one ordinary itemized Email in one call: provide the exact extraction and Product decisions. Cubby generates stable operation/line IDs and uses its normal prepare/commit writers. Incomplete evidence stays incomplete. A needs_resolution result returns the prepared receipt for targeted Product resolution; never re-prepare it. On operation_error, the write outcome may be unknown: replay identical input to recover its durable result before changing it.",
    parameters: Type.Unsafe<JsonObject>(parameters),
    structuredOutputSchema: Type.Unsafe<JsonObject>(resultSchema),
    replay: "safe",
    outputLimits: {
      maxBytes: MAIL_READ_RESPONSE_MAX_BYTES * 2,
      maxLines: 10_000,
    },
    execute: async (raw, api, context) => {
      const args = input.parse(raw);
      const finish = (value: z.infer<typeof output>) => ({
        output: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredOutput: z.json().parse(value),
        isError: value.kind === "operation_error",
      });
      const claimed = ordinaryEvidence();
      if (
        !claimed ||
        claimed.mailboxId !== args.mail.mailboxId ||
        claimed.messageId !== args.mail.messageId ||
        claimed.checksum !== args.mail.checksum
      )
        return finish({
          kind: "incomplete",
          reason:
            "The ordinary path requires the current admitted Email's complete, untruncated, attachment-free evidence. Use the exception flow for incomplete pages, attachments or other originals.",
        });
      if (args.extraction.status !== "ready")
        return finish({
          kind: "incomplete",
          reason:
            "Resolve the Email with its precise evidence gap; incomplete extraction does not establish priced itemization.",
        });
      const identity = await sha256Hex(
        JSON.stringify({
          runId,
          mail: args.mail,
          vendorId: args.vendorId,
          vendor: args.vendor,
          targetPurchaseId: args.targetPurchaseId,
          extraction: args.extraction,
        }),
      );
      const stableOrderId = `mail:${identity}`;
      const lineIds = args.extraction.candidate.lines.map(
        (_, index) => `line-${index + 1}`,
      );
      const preparation = preparePurchaseImportInput.parse({
        _runExecution: { runId, operationId: `extract:${identity}:prepare` },
        orders: [
          {
            vendorId: args.vendorId,
            vendor: args.vendor,
            targetPurchaseId: args.targetPurchaseId,
            stableOrderId,
            itemOperationId: `extract:${identity}:item`,
            source: {
              kind: "mail_message",
              externalKey: `gmail:${args.mail.mailboxId}:${args.mail.messageId}`,
              checksum: args.mail.checksum,
            },
            evidenceChecksum: args.mail.checksum,
            extractionRevision: "mail-extraction@2",
            extraction: args.extraction,
            lineIds,
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      });
      const { _runExecution, ...prepareInput } = preparation;
      const preparedResult = await api.executeTool(
        "mcp__cubby__purchase_import",
        z.record(z.string(), z.json()).parse(
          JSON.parse(
            JSON.stringify({
              action: "prepare",
              input: prepareInput,
              _runExecution,
            }),
          ),
        ),
        context,
        { key: "prepare" },
      );
      const prepared = nestedValue(preparedResult, preparePurchaseImportOut);
      if (preparedResult.isError || !prepared.success)
        return finish({
          kind: "operation_error",
          stage: "prepare",
          operationId: _runExecution.operationId,
          diagnostic: JSON.stringify(
            preparedResult.structuredOutput ?? preparedResult.diagnostics,
          ).slice(0, 8_000),
        });
      const resolutions = prepared.data.orders.flatMap((order) =>
        order.lines.flatMap((line) => {
          if (!line.requiresProductResolution) return [];
          const position = lineIds.indexOf(line.stableLineId);
          const resolution = args.products[position];
          // Candidate identity needs a source-backed decision. A proposed new
          // Product made before preparation has not reviewed these candidates.
          if (resolution?.kind === "new" && line.candidates.length > 0)
            return [];
          return resolution
            ? [
                {
                  stableOrderId: order.stableOrderId,
                  stableLineId: line.stableLineId,
                  resolution,
                },
              ]
            : [];
        }),
      );
      if (
        resolutions.length !==
        prepared.data.orders.flatMap((order) =>
          order.lines.filter((line) => line.requiresProductResolution),
        ).length
      )
        return finish({ kind: "needs_resolution", preparation: prepared.data });
      const defaults = {
        defaultTrade: args.defaultTrade,
        defaultProjectId: args.defaultProjectId,
      };
      const commitId = `extract:${await sha256Hex(JSON.stringify({ prepare: prepared.data.operationId, resolutions, ...defaults }))}:commit`;
      const commit = commitPurchaseImportInput.parse({
        _runExecution: { runId, operationId: commitId },
        prepareOperationId: prepared.data.operationId,
        resolutions,
        ...defaults,
      });
      const { _runExecution: commitExecution, ...commitInput } = commit;
      const committedResult = await api.executeTool(
        "mcp__cubby__purchase_import",
        z.record(z.string(), z.json()).parse(
          JSON.parse(
            JSON.stringify({
              action: "commit",
              input: commitInput,
              _runExecution: commitExecution,
            }),
          ),
        ),
        context,
        { key: "commit" },
      );
      const committed = nestedValue(committedResult, commitPurchaseImportOut);
      if (committedResult.isError || !committed.success)
        return finish({
          kind: "operation_error",
          stage: "commit",
          operationId: commitId,
          diagnostic: JSON.stringify(
            committedResult.structuredOutput ?? committedResult.diagnostics,
          ).slice(0, 8_000),
        });
      // Conflicts retain the current evidence and its recovery context. Only a
      // known publication advances to the next source; the nested claim keeps
      // that continuation durable without another coordination model turn.
      if (committed.data.items.some((item) => item.outcome === "conflict"))
        return finish({ kind: "commit_result", result: committed.data });
      const next = await api.executeTool(
        "claim_next_import_work",
        {},
        context,
        { key: "next-work" },
      );
      const nextWork = nestedValue(next, z.json());
      return finish({
        kind: "commit_result",
        result: committed.data,
        nextWork:
          !next.isError && nextWork.success
            ? nextWork.data
            : {
                kind: "retry",
                reason:
                  "The order committed, but continuation was interrupted. Claim the next Email; do not prepare this order again.",
              },
      });
    },
  });
}
