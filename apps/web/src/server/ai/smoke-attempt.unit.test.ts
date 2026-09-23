import { describe, expect, it } from "vitest";

import { finishSmokeAttempt, withSmokeUsage } from "./smoke-attempt";

const spec = { feature: "example-feature", model: "example-model" };

describe("AI smoke attempts", () => {
  it("keeps the Run shortcode on success and on provider failure", async () => {
    let clock = 0;
    const now = () => clock;
    const success = await finishSmokeAttempt(
      spec,
      "RUN-2222",
      async () => {
        clock = 1200;
        return { result: { choice: "example" } };
      },
      now,
    );
    expect(success).toMatchObject({
      status: "ok",
      runShortcode: "RUN-2222",
      durationMs: 1200,
      result: { choice: "example" },
    });

    clock = 0;
    const failure = await finishSmokeAttempt(
      spec,
      "RUN-3333",
      async () => {
        clock = 80;
        throw new Error("Gateway rejected the request");
      },
      now,
    );
    expect(failure).toMatchObject({
      status: "error",
      runShortcode: "RUN-3333",
      durationMs: 80,
      error: "Gateway rejected the request",
    });
  });

  it("distinguishes a deterministic path that made no model call", async () => {
    const result = await finishSmokeAttempt(spec, "RUN-4444", async () => ({
      result: null,
      noModelCall: true,
    }));
    expect(result.status).toBe("no_model_call");
  });

  it("reports the actual feature and a cached outcome", async () => {
    const attempt = await finishSmokeAttempt(spec, "RUN-4444", async () => ({
      result: { choice: "example" },
    }));
    expect(
      withSmokeUsage(attempt, [
        {
          feature: "overflow-feature",
          model: "overflow-model",
          cacheStatus: "none",
          applicationCacheStatus: "hit",
        },
      ]),
    ).toMatchObject({
      status: "no_model_call",
      feature: "overflow-feature",
      model: "overflow-model",
      runShortcode: "RUN-4444",
    });
    expect(withSmokeUsage(attempt, [])).toMatchObject({
      status: "no_model_call",
      runShortcode: "RUN-4444",
    });
  });
});
