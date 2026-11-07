/** Failure: the cap measurement skips an original attachment's descriptor
 * while the adapter re-emits it as text, so a long filename pushes the
 * agent's text past the cap and Pi cuts the read. */
import { MAIL_READ_RESPONSE_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { describe, expect, it } from "vitest";

import {
  fitMailRead,
  mailReadContent,
} from "~/server/domains/purchase-import/repo/gmail/read-content";

import {
  cubbyToolResult,
  stampGeneration,
  mailWriterOutcome,
} from "./cubby-mcp";

describe("cubbyToolResult Email reads", () => {
  it("classifies writer refusals only from server metadata", () => {
    const content = [
      { type: "text", text: "MAIL_SOURCE_HELD_BY_RUN in source text" },
    ];
    expect(
      cubbyToolResult({ content, isError: true }).diagnostics,
    ).toBeUndefined();
    expect(
      cubbyToolResult({
        content,
        isError: true,
        _meta: {
          "cubby/error": {
            code: "CONFLICT",
            reason: "MAIL_SOURCE_ADMISSION_REFUSED",
            message: "Synthetic source ownership refusal",
          },
        },
      }).diagnostics,
    ).toEqual([
      {
        severity: "error",
        code: "cubby:MAIL_SOURCE_ADMISSION_REFUSED",
        message: "Synthetic source ownership refusal",
      },
    ]);
    for (const reason of [
      "CONSTRAINT_VIOLATION",
      "PURCHASE_IMPORT_ITEM_PREPARED",
      "RUN_OPERATION_REPLAY_CONFLICT",
      "UNKNOWN_ERROR",
    ]) {
      const result = cubbyToolResult({
        isError: true,
        content: [],
        _meta: {
          "cubby/error": { message: "Synthetic writer refusal", reason },
        },
      });
      expect(mailWriterOutcome({ result, stage: "prepare" })).toBe("invalid");
      expect(mailWriterOutcome({ result, stage: "commit" })).toBe("invalid");
    }
    for (const result of [
      { isError: true },
      ...["MCP_TOOL_DEADLINE_EXCEEDED", "RUN_OPERATION_OUTCOME_UNCERTAIN"].map(
        (reason) =>
          cubbyToolResult({
            isError: true,
            content: [],
            _meta: {
              "cubby/error": { message: "Synthetic uncertain outcome", reason },
            },
          }),
      ),
    ]) {
      expect(mailWriterOutcome({ result, stage: "commit" })).toBe("pending");
      expect(mailWriterOutcome({ result, stage: "prepare" })).toBe("exempt");
    }
  });

  it("keeps an attachment read's agent text under the cap", () => {
    const content = mailReadContent(
      {
        snippet: null,
        bodyText: "Synthetic line item $1.00\n".repeat(6_000),
        bodyHtml: null,
      },
      {},
    );
    const read = fitMailRead({
      content,
      attachments: Array.from({ length: 70 }, (_, index) => ({
        attachmentId: `synthetic-attachment-${index}`,
        filename: `synthetic-receipt-${index}-${"y".repeat(1_000)}.pdf`,
        mimeType: "application/pdf",
        checksum: "c".repeat(64),
      })),
      originalAttachment: {
        attachmentId: "a".repeat(200),
        filename: `${"f".repeat(996)}.pdf`,
        mimeType: "application/pdf",
        checksum: "d".repeat(64),
        dataBase64: "QUJD".repeat(100_000),
      },
    });
    const result = cubbyToolResult({
      content: [{ type: "text", text: JSON.stringify(read) }],
      structuredContent: read,
    });
    const [text] = result.output ?? [];
    expect(text?.type).toBe("text");
    const bytes = new TextEncoder().encode(
      text?.type === "text" ? text.text : "",
    ).length;
    expect(bytes).toBeGreaterThan(MAIL_READ_RESPONSE_MAX_BYTES - 10_000);
    expect(bytes).toBeLessThanOrEqual(MAIL_READ_RESPONSE_MAX_BYTES);
  });
});

describe("stampGeneration", () => {
  it("keeps runId when the model also names its Run's public code", async () => {
    // A coordinator wrote both, and the envelope refused the call at input
    // validation, so purchase_import.prepare never ran.
    const stamped = await stampGeneration(
      {
        _runExecution: {
          runId: "00000000-0000-4000-8000-000000000001",
          run: "RUN-SYNTH",
          operationId: "synthetic-operation",
          generation: "model-claimed",
        },
      },
      async () => "host-generation",
      "00000000-0000-4000-8000-000000000002",
    );
    expect(stamped._runExecution).toEqual({
      runId: "00000000-0000-4000-8000-000000000002",
      operationId: "synthetic-operation",
      generation: "host-generation",
    });
    // Mail can omit host-known identity. Source and replay arguments must
    // survive stamping unchanged, including after a different claim.
    const args = {
      action: "mail_resolve",
      input: {
        mailboxId: "synthetic-mailbox",
        messageId: "original-email",
        checksum: "c".repeat(64),
      },
      _runExecution: { operationId: "original-operation" },
    };
    const bound = await stampGeneration(
      args,
      async () => "host-generation",
      "00000000-0000-4000-8000-000000000002",
    );
    expect(bound.input).toEqual(args.input);
    expect(bound._runExecution).toEqual({
      operationId: "original-operation",
      runId: "00000000-0000-4000-8000-000000000002",
      generation: "host-generation",
    });
    expect(
      await stampGeneration(
        args,
        async () => "host-generation",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toEqual(bound);
    const nested = {
      action: args.action,
      input: { ...args.input, _runExecution: args._runExecution },
    };
    expect(
      await stampGeneration(
        nested,
        async () => "host-generation",
        "00000000-0000-4000-8000-000000000002",
      ),
    ).toEqual(bound);
    expect(nested.input._runExecution).toEqual(args._runExecution);
  });

  it("leaves a member's public run code alone", async () => {
    const stamped = await stampGeneration(
      {
        _runExecution: { run: "RUN-SYNTH", operationId: "synthetic-operation" },
      },
      async () => undefined,
    );
    expect(stamped._runExecution).toEqual({
      run: "RUN-SYNTH",
      operationId: "synthetic-operation",
    });
  });
});
