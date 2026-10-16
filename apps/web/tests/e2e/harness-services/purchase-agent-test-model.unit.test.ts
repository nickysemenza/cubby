import { createModels } from "@earendil-works/pi-ai/models";
import { fundedCubbyPiProviders } from "@cubby/shared/ai/pi-providers";
import { expect, it } from "vitest";
import harness from "./purchase-agent-test-model";

// Native Messages blocks must drive the same script, including output references,
// signals, inference checks, gates and terminal text, through Pi's actual SDK.
it("plays the script through the funded Anthropic SDK transport", async () => {
  await harness.fetch(
    new Request("https://fake/configure", {
      method: "POST",
      body: JSON.stringify({
        expectedInference: { model: "claude-opus-5-5", effort: "high" },
        steps: [{ call: "claim", tool: "claim_next_import_work", args: {} }],
        purposeSteps: {
          mail: [
            { call: "claim", tool: "claim_next_import_work", args: {} },
            { check: "claim", includes: "synthetic-source" },
            { gate: "ready" },
            {
              call: "read",
              tool: "read_source",
              args: {
                source: { $from: "claim", path: "source" },
                event: {
                  $signal: "purchase-import.start_or_resume",
                  path: "purpose",
                },
              },
            },
            { await: ["finished"], text: "Waiting for evidence." },
          ],
        },
      }),
    }),
  );
  const models = createModels();
  const requests: Request[] = [];
  for (const provider of fundedCubbyPiProviders(() => async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return harness.fetch(request);
  }))
    models.setProvider(provider);
  const model = models.getModel("anthropic", "claude-opus-5-5");
  if (!model) throw new Error("Missing Anthropic model");
  const messages = [
    {
      role: "user" as const,
      content:
        '<signal type="purchase-import.start_or_resume">{"purpose":"mail"}</signal>',
      timestamp: 0,
    },
  ];
  const first = await models.completeSimple(
    model,
    { messages },
    { reasoning: "high", apiKey: "synthetic" },
  );
  expect(first.stopReason).toBe("toolUse");
  expect(first.content).toContainEqual(
    expect.objectContaining({
      type: "toolCall",
      id: "claim",
      name: "claim_next_import_work",
      arguments: {},
    }),
  );
  const transcript = [
    ...messages,
    first,
    {
      role: "toolResult" as const,
      toolCallId: "claim",
      toolName: "claim_next_import_work",
      content: [
        { type: "text" as const, text: '{"source":"synthetic-source"}' },
      ],
      isError: false,
      timestamp: 0,
    },
  ];
  const pending = models.completeSimple(
    model,
    { messages: transcript },
    { reasoning: "high", apiKey: "synthetic" },
  );
  await expect
    .poll(async () =>
      (await harness.fetch(new Request("https://fake/emitted"))).json(),
    )
    .toEqual(["claim", "gate:ready"]);
  await harness.fetch(
    new Request("https://fake/release", {
      method: "POST",
      body: '{"gate":"ready"}',
    }),
  );
  const second = await pending;
  expect(second.content).toContainEqual(
    expect.objectContaining({
      type: "toolCall",
      id: "read",
      arguments: { source: "synthetic-source", event: "mail" },
    }),
  );
  const final = await models.completeSimple(
    model,
    {
      messages: [
        ...transcript,
        second,
        {
          role: "toolResult",
          toolCallId: "read",
          toolName: "read_source",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 0,
        },
      ],
    },
    { reasoning: "high", apiKey: "synthetic" },
  );
  expect(final.stopReason).toBe("stop");
  expect(final.content).toContainEqual({
    type: "text",
    text: "Waiting for evidence.",
  });
  expect(requests[0]?.url).toContain("/messages");
  expect(
    await (await harness.fetch(new Request("https://fake/violations"))).json(),
  ).toEqual([]);
});

// A held request must retain its own encoding when another provider arrives.
it("keeps wire selection local while requests interleave", async () => {
  const send = (
    path: string,
    body: import("@earendil-works/pi-ai").JsonValue,
  ) =>
    harness.fetch(
      new Request(`https://fake${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  await send("/configure", {
    steps: [{ gate: "held" }, { call: "next", tool: "read_source", args: {} }],
  });
  const held = send("/v1/messages", {
    messages: [{ role: "user", content: "Synthetic request" }],
  });
  await expect
    .poll(async () =>
      (await harness.fetch(new Request("https://fake/emitted"))).json(),
    )
    .toEqual(["gate:held"]);
  const other = send("/v1/responses", {
    input: [{ content: "Synthetic request" }],
  });
  await send("/release", { gate: "held" });
  const responses = await other;
  expect(await responses.text()).toContain('"type":"response.completed"');
  const messages = await held;
  const encoded = await messages.text();
  expect(encoded).toContain("event: message_stop");
  expect(encoded).toContain('"stop_reason":"tool_use"');
  expect(encoded).not.toContain("response.completed");
});
