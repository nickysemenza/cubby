import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cubbyPiProviders } from "./pi-gateway";

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
