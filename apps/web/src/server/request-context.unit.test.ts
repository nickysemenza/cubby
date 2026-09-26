import { runEntityId } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  createRequestContext,
  type RequestActor,
} from "~/server/request-context";

const userId = testUserId("attribution-user");
const runId = runEntityId.parse("00000000-0000-4000-8000-000000000001");

// Every audit row and run copies these fields from the request actor. A
// verified-credential field silently dropped here (as the MCP client id once
// was) makes Claude, ChatGPT and Flue writes indistinguishable.
describe("createRequestContext caller attribution", () => {
  it.each<[string, RequestActor, object]>([
    [
      "an MCP client scoped to a run",
      {
        userId,
        sessionId: null,
        channel: "mcp",
        oauthClientId: "client-a",
        runId,
      },
      { channel: "mcp", oauthClientId: "client-a", runId },
    ],
    [
      "an API key",
      { userId, sessionId: null, channel: "api" },
      { channel: "api", oauthClientId: null, runId: null, deviceId: null },
    ],
  ])("keeps the attribution of %s", async (_, actor, expected) => {
    const context = await createRequestContext({
      headers: new Headers(),
      actor,
    });
    expect(context.actorContext).toMatchObject({ userId, ...expected });
  });
});
