import type { HttpRequest } from "@cubby/recipebridge";
import { describe, expect, it, vi } from "vitest";

import {
  createGatewaySend,
  type ForwardGatewayRequest,
} from "./gateway-transport";

const request: HttpRequest = {
  path: "/anthropic/v1/messages",
  headers: [
    ["content-type", "application/json"],
    ["anthropic-version", "2023-06-01"],
  ],
  body: { model: "claude-haiku", max_tokens: 16000 },
};

describe("cookbook gateway transport", () => {
  it("converts the crate's request and response shapes", async () => {
    const forward = vi.fn<ForwardGatewayRequest>().mockResolvedValue({
      status: 200,
      headers: [["cf-aig-log-id", "abc"]],
      body: '{"content":[]}',
    });

    const response = await createGatewaySend(forward)(request);

    expect(forward).toHaveBeenCalledWith({
      path: "/anthropic/v1/messages",
      headers: [
        ["content-type", "application/json"],
        ["anthropic-version", "2023-06-01"],
      ],
      body: { model: "claude-haiku", max_tokens: 16000 },
    });
    expect(response).toEqual({
      status: 200,
      headers: [["cf-aig-log-id", "abc"]],
      body: '{"content":[]}',
    });
  });

  it("passes a 429 straight back instead of retrying it", async () => {
    // Rate limits are the ladder's business: it decides whether to wait, step
    // down a tier, or give up on a model. Retrying here would burn the attempt
    // budget twice over and hide the signal that decision rests on.
    const forward = vi.fn<ForwardGatewayRequest>().mockResolvedValue({
      status: 429,
      headers: [["retry-after", "30"]],
      body: '{"type":"error","error":{"type":"rate_limit_error"}}',
    });

    const response = await createGatewaySend(forward)(request);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(429);
    expect(response.body).toBe(
      '{"type":"error","error":{"type":"rate_limit_error"}}',
    );
    expect(response.headers).toEqual([["retry-after", "30"]]);
  });

  it("passes a 500 body through untouched", async () => {
    const forward = vi.fn<ForwardGatewayRequest>().mockResolvedValue({
      status: 500,
      headers: [],
      body: "upstream exploded",
    });

    await expect(createGatewaySend(forward)(request)).resolves.toEqual({
      status: 500,
      headers: [],
      body: "upstream exploded",
    });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown network error and resolves with the first success", async () => {
    const forward = vi
      .fn<ForwardGatewayRequest>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue({ status: 200, headers: [], body: "ok" });

    const response = await createGatewaySend(forward)(request);

    expect(forward).toHaveBeenCalledTimes(2);
    expect(response.body).toBe("ok");
  });

  it("gives up after the retry budget so a dead connection surfaces", async () => {
    const forward = vi
      .fn<ForwardGatewayRequest>()
      .mockRejectedValue(new Error("Failed to fetch"));

    await expect(createGatewaySend(forward)(request)).rejects.toThrow(
      "Failed to fetch",
    );
    expect(forward).toHaveBeenCalledTimes(3);
  });
});
