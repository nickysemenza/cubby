import { EXTRACT_ORDER_TOOL } from "@cubby/schemas/import-run-agent";
import {
  mailMessageRef,
  MAIL_READ_RESPONSE_MAX_BYTES,
} from "@cubby/schemas/mailbox-research";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  importExtractionAgentInput,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  preparedProductResolution,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  defineTool,
  type NestedToolExecutionResult,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import { hasWriterVerdict, mailWriterOutcome } from "./cubby-mcp";
import type { MailAttemptEvidence } from "./mail-attempts";
import { CLAIM_IMPORT_WORK_TOOL } from "./tool-protocol";

const orderFields = preparePurchaseImportInput.shape.orders.element.shape;
export const extractedOrderInput = z
  .object({
    mail: mailMessageRef.extend({ checksum: orderFields.evidenceChecksum }),
    vendorId: orderFields.vendorId,
    vendor: orderFields.vendor,
    targetPurchaseId: orderFields.targetPurchaseId,
    distinctFromPurchases: orderFields.distinctFromPurchases,
    defaultTrade: commitPurchaseImportInput.shape.defaultTrade,
    defaultProjectId: commitPurchaseImportInput.shape.defaultProjectId,
    extraction: importExtractionAgentInput,
    products: z
      .array(preparedProductResolution.nullable())
      .max(500)
      .describe(
        "One Product decision per extracted line, in order. Use null for non-principal lines; never guess an existing Product or use expense_only for goods.",
      ),
  })
  .superRefine((value, context) => {
    const candidate = value.extraction.candidate;
    const lines = candidate?.lines ?? [];
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
    kind: z.literal("writer_refusal"),
    stage: z.enum(["prepare", "commit"]),
    operationId: z.string(),
    diagnostic: z.string(),
  }),
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

const collapseWhitespace = (value: string) =>
  value.replace(/\s+/gu, " ").trim();

/** Pi supplies source facts once; code owns IDs, preparation and publication. */
export function importExtractedOrderTool(
  runId: string,
  ordinaryEvidence: () => (MailAttemptEvidence & { text: string }) | undefined,
) {
  const { $schema: _inputDialect, ...parameters } = z.toJSONSchema(
    extractedOrderInput,
    {
      target: "draft-7",
      io: "input",
    },
  );
  const { $schema: _outputDialect, ...resultSchema } = z.toJSONSchema(output, {
    target: "draft-7",
  });
  return defineTool({
    name: EXTRACT_ORDER_TOOL,
    description:
      "Import one ordinary order Email in one call: provide the exact extraction, candidate.sourceReferences with literal Email excerpts, and Product decisions. Cubby generates stable operation/line IDs and uses its normal prepare/commit writers. A ready extraction books priced item lines. A USD confirmation that prints its total and item names but no item prices is needs_review with reason unpriced_itemization and null line amounts: Cubby books the printed total as one aggregate Expense beside unpriced item lines, with no review finding; never price an item from the total. Other incomplete evidence stays incomplete. A needs_resolution result returns the prepared receipt for targeted Product resolution; never re-prepare it. On writer_refusal, change the refused extraction or Product decision; do not resubmit identical input. A commit refusal can reuse its preparation with a repaired Product decision. On operation_error at prepare, no money was written: retry identical input. At commit the outcome is unknown: replay identical input to recover its durable result before changing it.",
    parameters,
    structuredOutputSchema: resultSchema,
    replay: "safe",
    outputLimits: {
      maxBytes: MAIL_READ_RESPONSE_MAX_BYTES * 2,
      maxLines: 10_000,
    },
    execute: async (raw, api, context) => {
      const args = extractedOrderInput.parse(raw);
      const finish = (
        value: z.infer<typeof output>,
        diagnostics?: NestedToolExecutionResult["diagnostics"],
      ) => ({
        output: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredOutput: z.json().parse(value),
        isError:
          value.kind === "operation_error" || value.kind === "writer_refusal",
        diagnostics,
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
      // A printed total with unpriced items imports through the aggregate
      // writer; any other incomplete extraction stays an evidence gap.
      if (
        args.extraction.status === "unreadable" ||
        (args.extraction.status === "needs_review" &&
          args.extraction.reason !== "unpriced_itemization")
      )
        return finish({
          kind: "incomplete",
          reason:
            "Resolve the Email with its precise evidence gap; incomplete extraction does not establish priced itemization or a printed total with unpriced items.",
        });
      const candidate = args.extraction.candidate;
      const refs = candidate.sourceReferences;
      const quotes = refs
        ? [
            refs.orderId,
            refs.orderedAt,
            refs.printedGrandTotal,
            ...refs.lines,
            ...refs.payments,
          ].filter((quote) => quote !== null)
        : [];
      // Excerpts copied across line breaks or table cells differ only in
      // whitespace; that refusal sent receipts to a stronger model (2026-11).
      const text = collapseWhitespace(claimed.text);
      const missing = quotes.filter(
        (quote) => !text.includes(collapseWhitespace(quote)),
      );
      if (
        !refs ||
        (candidate.orderId !== null && refs.orderId === null) ||
        (candidate.orderedAt !== null && refs.orderedAt === null) ||
        (candidate.printedGrandTotal !== null &&
          refs.printedGrandTotal === null) ||
        refs.lines.length !== candidate.lines.length ||
        refs.payments.length !== candidate.payments.length ||
        missing.length > 0
      )
        return finish({
          kind: "incomplete",
          reason: `Source references must quote the current retained Email and cover every submitted identifier, date, total, line and payment. Repair the references before publication.${
            missing.length > 0
              ? ` Not found in the Email: ${missing
                  .slice(0, 5)
                  .map((quote) => JSON.stringify(quote.slice(0, 120)))
                  .join(", ")}.`
              : ""
          }`,
        });
      // Writer operation IDs belong to this Run; canonical source identity
      // preserves earlier effects when identical facts replay in a successor.
      const identity = await sha256Hex(
        JSON.stringify({
          runId,
          mail: args.mail,
          vendorId: args.vendorId,
          vendor: args.vendor,
          targetPurchaseId: args.targetPurchaseId,
          distinctFromPurchases: args.distinctFromPurchases,
          extraction: args.extraction,
        }),
      );
      const stableOrderId = `mail:${identity}`;
      const lineIds = candidate.lines.map((_, index) => `line-${index + 1}`);
      const preparation = preparePurchaseImportInput.parse({
        _runExecution: { runId, operationId: `extract:${identity}:prepare` },
        orders: [
          {
            vendorId: args.vendorId,
            vendor: args.vendor,
            targetPurchaseId: args.targetPurchaseId,
            distinctFromPurchases: args.distinctFromPurchases,
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
      const prepareArguments = z.record(z.string(), z.json()).parse(
        JSON.parse(
          JSON.stringify({
            action: "prepare",
            input: prepareInput,
            _runExecution,
          }),
        ),
      );
      let preparedResult = await api.executeTool(
        "mcp__cubby__purchase_import",
        prepareArguments,
        context,
        { key: "prepare" },
      );
      let prepared = nestedValue(preparedResult, preparePurchaseImportOut);
      if (
        (preparedResult.isError && !hasWriterVerdict(preparedResult)) ||
        (!preparedResult.isError && !prepared.success)
      ) {
        preparedResult = await api.executeTool(
          "mcp__cubby__purchase_import",
          prepareArguments,
          context,
          { key: "prepare-receipt-recovery" },
        );
        prepared = nestedValue(preparedResult, preparePurchaseImportOut);
      }
      if (preparedResult.isError || !prepared.success)
        return finish(
          {
            kind:
              mailWriterOutcome({
                result: preparedResult,
                stage: "prepare",
              }) === "exempt"
                ? "operation_error"
                : "writer_refusal",
            stage: "prepare",
            operationId: _runExecution.operationId,
            diagnostic: (
              JSON.stringify(
                preparedResult.structuredOutput ?? preparedResult.diagnostics,
              ) ?? "No preparation verdict"
            ).slice(0, 8_000),
          },
          preparedResult.diagnostics,
        );
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
      const commitArguments = z.record(z.string(), z.json()).parse(
        JSON.parse(
          JSON.stringify({
            action: "commit",
            input: commitInput,
            _runExecution: commitExecution,
          }),
        ),
      );
      let committedResult = await api.executeTool(
        "mcp__cubby__purchase_import",
        commitArguments,
        context,
        { key: "commit" },
      );
      let committed = nestedValue(committedResult, commitPurchaseImportOut);
      if (
        (committedResult.isError &&
          mailWriterOutcome({ result: committedResult, stage: "commit" }) ===
            "pending" &&
          !committedResult.diagnostics?.some(
            (item) => item.code === "cubby:RUN_OPERATION_OUTCOME_UNCERTAIN",
          )) ||
        (!committedResult.isError && !committed.success)
      ) {
        committedResult = await api.executeTool(
          "mcp__cubby__purchase_import",
          commitArguments,
          context,
          { key: "commit-receipt-recovery" },
        );
        committed = nestedValue(committedResult, commitPurchaseImportOut);
      }
      if (committedResult.isError || !committed.success)
        return finish(
          {
            kind:
              !committedResult.isError ||
              mailWriterOutcome({
                result: committedResult,
                stage: "commit",
              }) === "pending"
                ? "operation_error"
                : "writer_refusal",
            stage: "commit",
            operationId: commitId,
            diagnostic: (
              (mailWriterOutcome({
                result: committedResult,
                stage: "commit",
              }) === "invalid"
                ? "Repair the refused extraction or Product decision. Do not resubmit identical input: the retained failed operation will report uncertain. "
                : "") +
              (JSON.stringify(
                committedResult.structuredOutput ?? committedResult.diagnostics,
              ) ?? "No commit verdict")
            ).slice(0, 8_000),
          },
          committedResult.diagnostics,
        );
      // Conflicts retain the current evidence and its recovery context. Only a
      // known publication advances to the next source; the nested claim keeps
      // that continuation durable without another coordination model turn.
      if (committed.data.items.some((item) => item.outcome === "conflict"))
        return finish({ kind: "commit_result", result: committed.data });
      const next = await api.executeTool(CLAIM_IMPORT_WORK_TOOL, {}, context, {
        key: "next-work",
      });
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
