/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- This deterministic fake answers the external OpenAI Responses wire shape. */
/**
 * The web Worker's AI Gateway in the coupled workerd harness, bound as
 * `CUBBY_TEST_AI_GATEWAY` (see `getTestAiGateway`). It answers Cubby's own
 * structured features — the receipt/order extractor and the required import
 * audit — with scenario-configured outputs, so the server's extraction,
 * validation, writer, and audit code all run unmodified. Optional `sources`
 * enables exact public page/search fixtures through the production observation
 * ports; omitting it preserves the normal cloud transport.
 */
import { z } from "zod";

import { isModelPricingRead } from "../../../tooling/ai/model-pricing-transport";

const fixtureSource = z.object({
  url: z.url(),
  title: z.string(),
  description: z.string(),
  html: z.string(),
});
const sourceConfiguration = z.object({
  sources: z.array(fixtureSource).max(10).optional(),
});
const decisionFixture = z.object({
  feature: z.string().min(1),
  match: z.string().min(1),
  label: z.string().min(1),
});

type Extraction = { match: string; output: unknown };
export type Fixture = {
  extractions: Extraction[];
  assessments: Extraction[];
  audit: unknown;
  sources?: z.infer<typeof fixtureSource>[];
  decisions?: z.infer<typeof decisionFixture>[];
};

let fixture: Fixture = {
  extractions: [],
  assessments: [],
  audit: { findings: [] },
};
let calls: Array<{ feature: string; matched: string | null; model?: string }> =
  [];
let callSequence = 0;

function requestFeature(request: Request) {
  const metadata = JSON.parse(
    request.headers.get("cf-aig-metadata") ?? "{}",
  ) as { feature?: string };
  return metadata.feature ?? "unknown";
}

/**
 * `runStructuredFeature` forces exactly one call to a `respond` tool and
 * reads the answer from its arguments, not from response text. pi-ai's
 * `Models.complete()` always streams on the wire (`models.js`'s `complete()`
 * awaits `stream().result()`), so this answers with the OpenAI Responses SSE
 * event sequence for a completed function-call turn: a `function_call`
 * output item followed by its arguments in one `.done` event, mirroring how
 * `openai-responses-shared.js` builds the `toolCall` content block.
 */
function respondWithToolCall(output: unknown) {
  callSequence += 1;
  const callId = `call_${callSequence}`;
  const itemId = `fc_${callSequence}`;
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name: "respond",
    arguments: JSON.stringify(output),
    status: "completed",
  };
  // pi-ai only finishes a tool call on its `output_item.done`; without it the
  // stream ends with an "unfinished tool call" error.
  const events = [
    { type: "response.created", response: { id: "gateway-response" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "gateway-response",
        status: "completed",
        output: [item],
        usage,
      },
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
  const configured = fixture.decisions?.find(
    (entry) => entry.feature === feature && input.state.includes(entry.match),
  );
  const label =
    configured?.label ??
    (feature === "expense-line-role"
      ? (JSON.parse(input.state) as { extractedLineKind: string })
          .extractedLineKind
      : JEV_DEFAULT_LABEL.get(feature));
  if (configured && !Object.values(criteria).includes(configured.label))
    throw new Error(
      "Configured decision label is absent from the actual request choices.",
    );
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

/** Explicit fixture transport shares the production observation port wire shape. */
async function sourceResponse(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/research-fixture-config" && request.method === "GET")
    return Response.json({ enabled: fixture.sources !== undefined });
  if (fixture.sources && url.pathname === "/research-search") {
    z.object({ query: z.string().min(1) }).parse(await request.json());
    return Response.json({
      items: fixture.sources.map(({ html: _html, ...lead }) => lead),
    });
  }
  if (fixture.sources && url.pathname === "/research-page") {
    const { url: pageURL } = z
      .object({ url: z.url() })
      .parse(await request.json());
    const page = fixture.sources.find((source) => source.url === pageURL);
    return Response.json(
      page
        ? { status: "fetched", url: page.url, html: page.html, durationMs: 1 }
        : {
            status: "blocked",
            reason: "No retained synthetic page at this URL",
            durationMs: 1,
          },
    );
  }
  return null;
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    // Illustrative catalog rates and complete bounds for synthetic inference.
    // Never used by production or peers that perform live inference.
    if (isModelPricingRead(request))
      return Response.json({
        "cloudflare-ai-gateway": {
          id: "cloudflare-ai-gateway",
          models: {
            "typesafe/jev": {
              id: "typesafe/jev",
              cost: { input: 0.5, output: 0 },
              limit: { context: 10_000, input: 9_000, output: 0 },
            },
          },
        },
        "cloudflare-workers-ai": {
          id: "cloudflare-workers-ai",
          models: {
            "@cf/cloudflare/clef": {
              id: "@cf/cloudflare/clef",
              cost: { input: 0.5, output: 0 },
              limit: { context: 10_000, input: 9_000, output: 0 },
            },
          },
        },
      });
    if (url.pathname === "/configure" && request.method === "POST") {
      const input = await request.json();
      const { sources } = sourceConfiguration.parse(input);
      const decisions = z
        .object({ decisions: z.array(decisionFixture).max(20).optional() })
        .parse(input).decisions;
      fixture = {
        assessments: [],
        audit: { findings: [] },
        ...(input as Partial<Fixture>),
        sources,
        decisions,
      } as Fixture;
      calls = [];
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/calls") return Response.json(calls);
    const retainedSource = await sourceResponse(request);
    if (retainedSource) return retainedSource;
    const feature = requestFeature(request);
    if (
      url.pathname === "/workers-ai/run/typesafe/jev" ||
      url.pathname === "/workers-ai/run/@cf/cloudflare/clef"
    ) {
      const choice = jevChoice(feature, await request.json());
      calls.push({
        feature,
        matched: choice.label,
        model: url.pathname.slice("/workers-ai/run/".length),
      });
      return Response.json(
        url.pathname.endsWith("/run/@cf/cloudflare/clef")
          ? choice.response
          : { result: choice.response },
      );
    }
    if (url.pathname !== "/openai/responses") {
      calls.push({ feature, matched: null });
      return new Response(`Unscripted gateway route ${url.pathname}`, {
        status: 501,
      });
    }
    const raw = await request.text();
    if (feature === "research-source-support") {
      const assessment = fixture.assessments.find(({ match }) =>
        raw.includes(match),
      );
      calls.push({ feature, matched: assessment?.match ?? null });
      if (assessment) return respondWithToolCall(assessment.output);
      return new Response("Unscripted research support assessment", {
        status: 501,
      });
    }
    if (feature === "purchase-import-audit") {
      calls.push({ feature, matched: "audit" });
      return respondWithToolCall(fixture.audit);
    }
    if (
      feature === "purchase-import-extraction" ||
      feature === "purchase-import-repair"
    ) {
      const extraction = fixture.extractions.find(({ match }) =>
        raw.includes(match),
      );
      calls.push({ feature, matched: extraction?.match ?? null });
      if (extraction) return respondWithToolCall(extraction.output);
    } else calls.push({ feature, matched: null });
    return new Response(`Unscripted gateway feature ${feature}`, {
      status: 501,
    });
  },
};
