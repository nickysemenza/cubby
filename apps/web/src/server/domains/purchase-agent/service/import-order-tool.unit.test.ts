import {
  commitPurchaseImportInput,
  preparePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { importExtractedOrderTool } from "./import-order-tool";

const runId = "10000000-0000-4000-8000-000000000001";
const mail = {
  mailboxId: "synthetic-mailbox",
  messageId: "synthetic-order",
  checksum: "a".repeat(64),
};
const sourceText =
  "Order SYN-100 on 2026-09-20. Synthetic mug 1 x $12.00. Total $12.00.";
const ordinaryMail = { ...mail, text: sourceText };
const extraction = {
  mail,
  vendor: { name: "Synthetic Shop" },
  extraction: {
    status: "ready",
    candidate: {
      orderId: "SYN-100",
      sourceReferences: {
        orderId: "Order SYN-100",
        orderedAt: "2026-09-20",
        printedGrandTotal: "Total $12.00",
        lines: ["Synthetic mug 1 x $12.00"],
        payments: [],
      },
      orderedAt: "2026-09-20",
      merchant: "Synthetic Shop",
      currency: "USD",
      printedGrandTotal: 12,
      lines: [
        {
          title: "Synthetic mug",
          amount: 12,
          quantity: 1,
          lineKind: "principal",
        },
      ],
      payments: [],
    },
  },
  products: [{ kind: "new" }],
};

function writerPeer(
  options: {
    candidate?: boolean;
    conflict?: boolean;
    unknownCommit?: boolean;
    refusal?: string;
  } = {},
) {
  const effects: { action: string; operation: string }[] = [];
  const commits: string[] = [];
  const claims: string[] = [];
  const api = fromPartial<ToolExecutionApi>({
    executeTool: async (name: string, args: JsonObject) => {
      if (name === "claim_next_import_work") {
        claims.push(name);
        return fromPartial({
          isError: false,
          diagnostics: [],
          structuredOutput: JSON.stringify({ kind: "none" }),
        });
      }
      expect(name).toBe("mcp__cubby__purchase_import");
      const fields = zObject(args.input);
      if (args.action === "prepare") {
        const parsed = preparePurchaseImportInput.parse({
          ...fields,
          _runExecution: args._runExecution,
        });
        effects.push({
          action: "prepare",
          operation: parsed._runExecution.operationId,
        });
        if (options.refusal)
          return fromPartial({
            isError: true,
            diagnostics: [
              {
                severity: "error",
                code: options.refusal,
                message: "Synthetic input refusal",
              },
            ],
          });
        const order = parsed.orders[0];
        if (!order) throw new Error("Synthetic preparation has no order");
        return fromPartial({
          isError: false,
          diagnostics: [],
          structuredOutput: JSON.stringify({
            runId: "RUN-2222",
            operationId: "canonical-prepared-receipt",
            status: "running",
            orders: [
              {
                ...order,
                orderId: "SYN-100",
                targetFingerprint: "b".repeat(64),
                evidenceFingerprint: "c".repeat(64),
                vendorCandidates: [],
                lines: [
                  {
                    stableLineId: "line-1",
                    title: "Synthetic mug",
                    amount: 12,
                    identifiers: {},
                    requiresProductResolution: true,
                    candidates: options.candidate
                      ? [
                          {
                            productId: "PRD-2222",
                            name: "Synthetic mug",
                            brandName: null,
                            model: null,
                            exactIdentifierMatch: true,
                            exactNameMatch: true,
                          },
                        ]
                      : [],
                  },
                ],
              },
            ],
          }),
        });
      }
      const parsed = commitPurchaseImportInput.parse({
        ...fields,
        _runExecution: args._runExecution,
      });
      effects.push({
        action: "commit",
        operation: parsed._runExecution.operationId,
      });
      commits.push(parsed.prepareOperationId);
      if (options.unknownCommit && commits.length === 1)
        return fromPartial({
          isError: true,
          diagnostics: [{ message: "Synthetic response lost after commit" }],
        });
      return fromPartial({
        isError: false,
        diagnostics: [],
        structuredOutput: JSON.stringify({
          runId: "RUN-2222",
          operationId: parsed._runExecution.operationId,
          status: "needs_review",
          items: [
            {
              stableOrderId: parsed.resolutions[0]?.stableOrderId,
              outcome: options.conflict ? "conflict" : "created",
              purchaseId: options.conflict ? null : "PUR-2222",
              findingCount: options.conflict ? 1 : 0,
            },
          ],
        }),
      });
    },
  });
  return { api, effects, commits, claims };
}

// Optional fields must pass through the same JSON boundary as MCP transport.
const zObject = (value: unknown) => z.record(z.string(), z.json()).parse(value);

describe("ordinary Email extraction", () => {
  it.each([false, true])(
    "uses the canonical preparation receipt and preserves commit conflict=%s on replay",
    async (conflict) => {
      const peer = writerPeer({ conflict });
      const tool = importExtractedOrderTool(runId, () => ordinaryMail);
      const first = await tool.execute(
        extraction,
        peer.api,
        BACKGROUND_CONTEXT,
      );
      const replay = await tool.execute(
        extraction,
        peer.api,
        BACKGROUND_CONTEXT,
      );
      expect(first.structuredOutput).toMatchObject({
        kind: "commit_result",
        result: { items: [{ outcome: conflict ? "conflict" : "created" }] },
      });
      expect(replay.structuredOutput).toEqual(first.structuredOutput);
      expect(peer.commits).toEqual([
        "canonical-prepared-receipt",
        "canonical-prepared-receipt",
      ]);
      expect(peer.effects.slice(0, 2)).toEqual(peer.effects.slice(2));
      expect(peer.claims).toHaveLength(conflict ? 0 : 2);
    },
  );

  it("recovers only uncertain writer outcomes before advancing", async () => {
    const peer = writerPeer({ unknownCommit: true });
    const result = await importExtractedOrderTool(
      runId,
      () => ordinaryMail,
    ).execute(extraction, peer.api, BACKGROUND_CONTEXT);
    expect(result.structuredOutput).toMatchObject({
      kind: "commit_result",
      result: { items: [{ outcome: "created" }] },
    });
    expect(
      peer.effects
        .filter((effect) => effect.action === "commit")
        .map((effect) => effect.operation),
    ).toEqual([peer.effects[1]?.operation, peer.effects[1]?.operation]);
    expect(peer.claims).toHaveLength(1);
    const refused = writerPeer({ refusal: "INVALID_INPUT" });
    const refusal = await importExtractedOrderTool(
      runId,
      () => ordinaryMail,
    ).execute(extraction, refused.api, BACKGROUND_CONTEXT);
    expect(refusal.diagnostics).toMatchObject([{ code: "INVALID_INPUT" }]);
    expect(refused.effects.map((effect) => effect.action)).toEqual(["prepare"]);
    expect(refused.claims).toEqual([]);
  });

  it("does not create a new Product before reviewing preparation candidates", async () => {
    const peer = writerPeer({ candidate: true });
    const result = await importExtractedOrderTool(
      runId,
      () => ordinaryMail,
    ).execute(extraction, peer.api, BACKGROUND_CONTEXT);
    expect(result.structuredOutput).toMatchObject({
      kind: "needs_resolution",
      preparation: { operationId: "canonical-prepared-receipt" },
    });
    expect(peer.effects.map((effect) => effect.action)).toEqual(["prepare"]);
  });

  it("does not write without the current complete checksum-bound evidence", async () => {
    const peer = writerPeer();
    const result = await importExtractedOrderTool(
      runId,
      () => undefined,
    ).execute(extraction, peer.api, BACKGROUND_CONTEXT);
    expect(result.structuredOutput).toMatchObject({ kind: "incomplete" });
    expect(peer.effects).toEqual([]);
    const { sourceReferences: _missing, ...withoutReferences } =
      extraction.extraction.candidate;
    const missingReference = await importExtractedOrderTool(
      runId,
      () => ordinaryMail,
    ).execute(
      {
        ...extraction,
        extraction: { ...extraction.extraction, candidate: withoutReferences },
      },
      peer.api,
      BACKGROUND_CONTEXT,
    );
    expect(missingReference.structuredOutput).toMatchObject({
      kind: "incomplete",
    });
    expect(peer.effects).toEqual([]);
    const inventedReference = await importExtractedOrderTool(
      runId,
      () => ordinaryMail,
    ).execute(
      {
        ...extraction,
        extraction: {
          ...extraction.extraction,
          candidate: {
            ...extraction.extraction.candidate,
            sourceReferences: {
              ...extraction.extraction.candidate.sourceReferences,
              printedGrandTotal: "Invented total $12.00",
            },
          },
        },
      },
      peer.api,
      BACKGROUND_CONTEXT,
    );
    expect(inventedReference.structuredOutput).toMatchObject({
      kind: "incomplete",
    });
    expect(peer.effects).toEqual([]);
  });
});
