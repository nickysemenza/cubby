/* eslint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This deterministic fake implements and recursively inspects the external OpenAI Responses wire shape. */
type ResponsesFunctionCall = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
};

type ModelFixture =
  | {
      mode?: "purchase";
      runId: string;
      productShortcode: string;
      sourceExternalKey: string;
      evidenceChecksum: string;
    }
  | {
      mode: "photo";
      runId: string;
      runShortcode: string;
      imageShortcode: string;
      productName: string;
    };

let fixture: ModelFixture | undefined;
let violations: string[] = [];

function sse(event: object) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function toolResponse(call: ResponsesFunctionCall) {
  const response = {
    id: `workerd-${call.id}`,
    status: "completed",
    output: [call],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return new Response(
    [
      sse({ type: "response.created", response: { id: response.id } }),
      sse({ type: "response.output_item.added", output_index: 0, item: call }),
      sse({ type: "response.output_item.done", output_index: 0, item: call }),
      sse({ type: "response.completed", response }),
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function textResponse(text: string) {
  const item = {
    type: "message",
    id: "workerd-waiting",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = {
    id: item.id,
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return new Response(
    [
      sse({ type: "response.created", response: { id: response.id } }),
      sse({ type: "response.output_item.added", output_index: 0, item }),
      sse({ type: "response.output_item.done", output_index: 0, item }),
      sse({ type: "response.completed", response }),
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function validationReplayed(body: unknown): boolean {
  if (typeof body === "string") {
    if (/"outcome"\s*:\s*"replayed"/u.test(body)) return true;
    try {
      return validationReplayed(JSON.parse(body));
    } catch {
      return false;
    }
  }
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body)) return body.some(validationReplayed);
  const record = body as Record<string, unknown>;
  if (record.outcome === "replayed") return true;
  return Object.values(record).some(validationReplayed);
}

const isFinishNudge = (item: unknown) =>
  JSON.stringify(item).includes('<signal type=\\"run_not_finished\\">');

/**
 * Regression: the agent once nudged after a terminating tool (a pending
 * browser command) and re-nudged each cycle from a stale guard, so under CI
 * load it hit Flue's 32-cycle runaway ceiling before browser evidence joined.
 * Either misbehavior is recorded deterministically, without needing the race;
 * the harness reads them from `/violations`. Flue retries a model error
 * response, so refusing the request would hide the misbehavior instead.
 */
function finishNudgeViolation(body: unknown): string | undefined {
  const input = (body as { input?: unknown[] }).input ?? [];
  const last = input.at(-1);
  if (!isFinishNudge(last)) return undefined;
  const before = input.at(-2) as
    | { type?: string; call_id?: string }
    | undefined;
  if (before?.type === "function_call_output" && before.call_id === "browser-1")
    return "Finish nudge after a pending browser command";
  for (const item of input.slice(0, -1).reverse()) {
    if ((item as { type?: string }).type === "function_call_output")
      return undefined;
    if (isFinishNudge(item))
      return "Repeated finish nudge without a new tool call";
  }
  return undefined;
}

const call = (
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): ResponsesFunctionCall => ({
  type: "function_call",
  id,
  call_id: id,
  name,
  arguments: JSON.stringify(arguments_),
});

/** Deterministic coordinator for the real browser -> MCP validation flow. */
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/configure" && request.method === "POST") {
      fixture = (await request.json()) as ModelFixture;
      violations = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/violations") return Response.json(violations);
    if (!fixture)
      return new Response("Fixture is not configured", { status: 409 });

    const body = await request.json();
    const requestBody = JSON.stringify(body);
    const violation = finishNudgeViolation(body);
    if (violation) violations.push(violation);
    if (fixture.mode === "photo") {
      if (!requestBody.includes("photo-claim"))
        return toolResponse(
          call("photo-claim", "claim_next_import_work", {
            operationId: "photo-claim",
          }),
        );
      if (!requestBody.includes("photo-propose"))
        return toolResponse(
          call("photo-propose", "mcp__cubby__photo_run", {
            action: "propose_groups",
            runId: fixture.runShortcode,
            _runExecution: {
              runId: fixture.runId,
              operationId: "photo-propose",
            },
            groups: [
              {
                groupKey: "synthetic-wardrobe-item",
                images: [{ id: fixture.imageShortcode, purpose: "item" }],
                product: {
                  kind: "create",
                  create: { name: fixture.productName },
                },
                evidence:
                  "Synthetic item photo; review the proposed identity before creating a Product.",
              },
            ],
          }),
        );
      if (!requestBody.includes("photo-list"))
        return toolResponse(
          call("photo-list", "mcp__cubby__imports_read", {
            action: "photo_proposals",
            runId: fixture.runShortcode,
          }),
        );
      return toolResponse(
        call("photo-await", "report_agent_progress", {
          operationId: "photo-await",
          phase: "awaiting_approval",
          awaitingApproval: true,
          detail: "One synthetic item is ready for review",
        }),
      );
    }
    if (!requestBody.includes("claim-initial")) {
      return toolResponse(
        call("claim-initial", "claim_next_import_work", {
          operationId: "claim-initial",
        }),
      );
    }

    if (!requestBody.includes("browser-1")) {
      return toolResponse(
        call("browser-1", "issue_browser_command", {
          operationId: "capture-order",
          command: {
            kind: "capture_order",
            target: "https://shop.example.test/orders/ORDER-WORKERD-1",
          },
        }),
      );
    }

    if (!requestBody.includes("purchase-import.browser_result")) {
      if (
        requestBody.includes("purchase-import.browser_connected") &&
        !requestBody.includes("claim-resume")
      ) {
        return toolResponse(
          call("claim-resume", "claim_next_import_work", {
            operationId: "claim-resume",
          }),
        );
      }
      return textResponse("Browser result continuation is pending.");
    }

    if (!requestBody.includes("claim-resume")) {
      return toolResponse(
        call("claim-resume", "claim_next_import_work", {
          operationId: "claim-resume",
        }),
      );
    }

    if (!requestBody.includes("prepare:workerd")) {
      return toolResponse(
        call("prepare-1", "mcp__cubby__purchase_import", {
          action: "prepare",
          _runExecution: {
            runId: fixture.runId,
            operationId: "prepare:workerd",
            itemOperationIds: ["prepare-item:workerd"],
          },
          orders: [
            {
              stableOrderId: "order-workerd",
              itemOperationId: "prepare-item:workerd",
              source: {
                kind: "browser_order",
                externalKey: fixture.sourceExternalKey,
                checksum: fixture.evidenceChecksum,
              },
              evidenceChecksum: fixture.evidenceChecksum,
              extractionRevision: "workerd@1",
              extraction: {
                status: "ready",
                candidate: {
                  orderId: "ORDER-WORKERD-1",
                  orderedAt: "2026-09-20T12:00:00.000Z",
                  merchant: "Workerd harness vendor",
                  currency: "USD",
                  printedGrandTotal: 12.34,
                  lines: [
                    {
                      title: "Workerd validation product",
                      amount: 12.34,
                      lineKind: "principal",
                      quantity: 1,
                    },
                  ],
                  payments: [],
                  allShipmentsDelivered: false,
                },
              },
              lineIds: ["order-workerd:line-1"],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        }),
      );
    }

    if (!requestBody.includes("validate:workerd")) {
      return toolResponse(
        call("validate-1", "mcp__cubby__purchase_import", {
          action: "validate",
          _runExecution: {
            runId: fixture.runId,
            operationId: "validate:workerd",
          },
          prepareOperationId: "prepare:workerd",
          resolutions: [
            {
              stableOrderId: "order-workerd",
              stableLineId: "order-workerd:line-1",
              resolution: {
                kind: "existing",
                productId: fixture.productShortcode,
              },
            },
          ],
        }),
      );
    }

    if (!validationReplayed(body)) {
      return new Response("Validation did not produce replayed", {
        status: 422,
      });
    }
    return toolResponse(
      call("finish-1", "finish_import_run", {
        operationId: "finish-after-validation",
      }),
    );
  },
};
