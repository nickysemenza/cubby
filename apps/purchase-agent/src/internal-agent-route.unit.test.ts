import { describe, expect, it } from "vitest";

import {
  INTERNAL_AGENT_HEADER,
  INTERNAL_AGENT_HEADER_VALUE,
  INTERNAL_AGENT_PATH,
  internalAgentRoute,
} from "./internal-agent-route";

describe("private purchase-agent route contract", () => {
  it.each(["GET", "HEAD", "POST"])(
    "forwards %s to Flue with the mount prefix removed",
    (method) => {
      const routed = internalAgentRoute(
        new Request(
          `https://purchase-agent.internal${INTERNAL_AGENT_PATH}/run%3Aabc/abort?cursor=9`,
          {
            method,
            headers: {
              [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_HEADER_VALUE,
            },
          },
        ),
      );
      if (!("request" in routed)) throw new Error("Expected routed request");

      expect(routed.request.method).toBe(method);
      expect(new URL(routed.request.url)).toMatchObject({
        pathname: "/run%3Aabc/abort",
        search: "?cursor=9",
      });
    },
  );

  it("rejects missing service markers and unrelated paths", () => {
    expect(
      internalAgentRoute(
        new Request(
          `https://purchase-agent.internal${INTERNAL_AGENT_PATH}/run`,
        ),
      ),
    ).toEqual({ status: 403 });
    expect(
      internalAgentRoute(
        new Request("https://purchase-agent.internal/public", {
          headers: { [INTERNAL_AGENT_HEADER]: INTERNAL_AGENT_HEADER_VALUE },
        }),
      ),
    ).toEqual({ status: 404 });
  });
});
