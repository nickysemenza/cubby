import { createModels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { cubbyPiProviders } from "./pi-gateway";

describe("cubbyPiProviders compat route", () => {
  // Google AI Studio's OpenAI-compatible endpoint answers 400 `Unknown name
  // "store"`. The placeholder base URL hides the Gateway from pi-ai's
  // detection, so the compat models must declare it themselves.
  it("sends Gemini a chat completion without OpenAI-only fields", async () => {
    let body: unknown;
    const models = createModels();
    for (const provider of cubbyPiProviders(() => async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response("upstream refused", { status: 400 });
    }))
      models.setProvider(provider);
    const model = models.getModel(
      "compat",
      "google-ai-studio/gemini-2.5-flash",
    );
    if (!model) throw new Error("compat model is not declared");
    await models.complete(model, {
      messages: [
        { role: "user", content: "Synthetic prompt", timestamp: Date.now() },
      ],
    });
    expect(z.looseObject({}).parse(body)).not.toHaveProperty("store");
  });
});
