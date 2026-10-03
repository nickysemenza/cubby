/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- This deterministic fake answers the external OpenAI Responses wire shape. */
/**
 * The web Worker's AI Gateway in the coupled workerd harness, bound as
 * `CUBBY_TEST_AI_GATEWAY` (see `getTestAiGateway`). It answers Cubby's own
 * structured features — the receipt/order extractor and the required import
 * audit — with scenario-configured outputs, so the server's extraction,
 * validation, writer, and audit code all run unmodified.
 */
type Extraction = { match: string; output: unknown };
type Fixture = { extractions: Extraction[]; audit: unknown };

let fixture: Fixture = { extractions: [], audit: { findings: [] } };
let calls: Array<{ feature: string; matched: string | null }> = [];

function respond(output: unknown, stream: boolean) {
  const text = JSON.stringify(output);
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  if (!stream)
    return Response.json({
      id: "gateway-response",
      object: "response",
      status: "completed",
      model: "workerd-gateway",
      output: [
        {
          type: "message",
          id: "gateway-message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage,
    });
  const events = [
    { type: "response.created", response: { id: "gateway-response" } },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: { id: "gateway-response", status: "completed", usage },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/**
 * The writer's closed-set Jev decisions, answered as a careful reader would:
 * a row keeps its extracted role, is one sellable item worth a Product, a
 * negative item row is a return, and no fuzzy catalog candidate is claimed
 * (exact identifiers resolve before Jev is asked).
 */
const JEV_DEFAULT_LABEL = new Map([
  ["kit-detection", "single"],
  ["product-promotion", "promote"],
  ["reversal-kind", "return"],
  ["product-line-identity", "No listed choice is a suitable match."],
]);

function jevChoice(feature: string, body: unknown) {
  const input = body as {
    state: string;
    questions: { selection: { criteria: Record<string, string> } };
  };
  const criteria = input.questions.selection.criteria;
  const label =
    feature === "expense-line-role"
      ? (JSON.parse(input.state) as { extractedLineKind: string })
          .extractedLineKind
      : JEV_DEFAULT_LABEL.get(feature);
  const key =
    Object.entries(criteria).find(([, value]) => value === label)?.[0] ??
    Object.keys(criteria)[0] ??
    "none";
  return {
    label: label ?? null,
    response: {
      answers: {
        selection: {
          type: "choice",
          choice: key,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(criteria).map((entry) => [
              entry,
              entry === key ? 1 : 0,
            ]),
          ),
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/configure" && request.method === "POST") {
      fixture = {
        audit: { findings: [] },
        ...((await request.json()) as Partial<Fixture>),
      } as Fixture;
      calls = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/calls") return Response.json(calls);
    const metadata = JSON.parse(
      request.headers.get("cf-aig-metadata") ?? "{}",
    ) as { feature?: string };
    const feature = metadata.feature ?? "unknown";
    if (url.pathname === "/workers-ai/run/typesafe/jev") {
      const choice = jevChoice(feature, await request.json());
      calls.push({ feature, matched: choice.label });
      return Response.json({ result: choice.response });
    }
    if (url.pathname !== "/openai/responses") {
      calls.push({ feature, matched: null });
      return new Response(`Unscripted gateway route ${url.pathname}`, {
        status: 501,
      });
    }
    const raw = await request.text();
    const body = JSON.parse(raw) as { stream?: boolean };
    if (feature === "purchase-import-audit") {
      calls.push({ feature, matched: "audit" });
      return respond(fixture.audit, body.stream === true);
    }
    if (
      feature === "purchase-import-extraction" ||
      feature === "purchase-import-repair"
    ) {
      const extraction = fixture.extractions.find(({ match }) =>
        raw.includes(match),
      );
      calls.push({ feature, matched: extraction?.match ?? null });
      if (extraction) return respond(extraction.output, body.stream === true);
    } else calls.push({ feature, matched: null });
    return new Response(`Unscripted gateway feature ${feature}`, {
      status: 501,
    });
  },
};
