/* eslint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This deterministic fake implements and recursively inspects the external OpenAI Responses wire shape. */
type ResponsesFunctionCall = {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
};

type ModelFixture = {
  runId: string;
  productShortcode: string;
  sourceExternalKey: string;
  evidenceChecksum: string;
};

let fixture: ModelFixture | undefined;

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
      return new Response(null, { status: 204 });
    }
    if (!fixture)
      return new Response("Fixture is not configured", { status: 409 });

    const body = await request.json();
    const requestBody = JSON.stringify(body);
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
        call("prepare-1", "mcp__cubby__prepare_purchase_import", {
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
        call("validate-1", "mcp__cubby__validate_purchase_import", {
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
