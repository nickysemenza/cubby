import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cubbyPiProviders, piTokenUsage } from "./pi-providers";

const responsesBody = z.object({
  input: z.array(z.looseObject({ content: z.unknown().optional() })),
});

describe("cubbyPiProviders OpenAI route", () => {
  // pi-ai's only binary content is an image, so a PDF receipt would reach
  // the Responses API as `input_image` with a PDF data URL, which it rejects;
  // a PDF must be an `input_file`.
  it("sends a PDF as an input file and leaves images as images", async () => {
    let body: unknown;
    const models = createModels();
    for (const provider of cubbyPiProviders(() => async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("synthetic refusal", { status: 400 });
    }))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-luna");
    if (!model) throw new Error("gpt-6-luna is not declared");
    await models.complete(model, {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: "JVBERi0=", mimeType: "application/pdf" },
            { type: "image", data: "iVBORw0=", mimeType: "image/png" },
            { type: "text", text: "Extract this synthetic receipt." },
          ],
          timestamp: Date.now(),
        },
      ],
    });
    const content = responsesBody
      .parse(body)
      .input.flatMap((item) =>
        Array.isArray(item.content) ? item.content : [],
      );
    expect(content).toContainEqual({
      type: "input_file",
      filename: "evidence.pdf",
      file_data: "data:application/pdf;base64,JVBERi0=",
    });
    expect(content).toContainEqual(
      expect.objectContaining({
        type: "input_image",
        image_url: "data:image/png;base64,iVBORw0=",
      }),
    );
    expect(JSON.stringify(content)).not.toContain(
      '"image_url":"data:application/pdf',
    );
  });
});

// A gateway cache HIT replays a stored answer the gateway does not bill, so
// its pi-ai catalog price must not reach the transcript or usage ledger.
describe("cubbyPiProviders cost normalization", () => {
  const completed = (headers: Record<string, string>) =>
    new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "example-response",
          status: "completed",
          output: [],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream", ...headers } },
    );

  async function costFor(headers: Record<string, string>) {
    const models = createModels();
    for (const provider of cubbyPiProviders(
      () => async () => completed(headers),
    ))
      models.setProvider(provider);
    const model = models.getModel("openai", "gpt-6-sol");
    if (!model) throw new Error("gpt-6-sol is not declared");
    const message = await models.complete(model, { messages: [] });
    return { cost: message.usage.cost.total, input: message.usage.input };
  }

  it("zeroes a gateway cache hit's cost but keeps its token evidence", async () => {
    expect(await costFor({ "cf-aig-cache-status": "HIT" })).toEqual({
      cost: 0,
      input: 100,
    });
  });

  it("keeps the catalog price on a cache miss", async () => {
    expect(
      (await costFor({ "cf-aig-cache-status": "MISS" })).cost,
    ).toBeGreaterThan(0);
  });
});

// An upstream failure can leave pi's initialized zero counts without a usage
// report. These are unknown, while a failed validation can retain billed tokens.
it("keeps failed calls without reported tokens unknown", () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  expect(piTokenUsage({ stopReason: "error", usage })).toMatchObject({
    inputTokens: null,
    outputTokens: null,
  });
  expect(
    piTokenUsage({
      stopReason: "error",
      usage: { ...usage, input: 100, totalTokens: 100 },
    }),
  ).toMatchObject({ inputTokens: 100, outputTokens: 0 });
  expect(piTokenUsage({ stopReason: "stop", usage })).toMatchObject({
    inputTokens: 0,
    outputTokens: 0,
  });
});
