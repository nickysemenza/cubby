import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("database notification Durable Object", () => {
  it("rings household.changed over a hibernating socket without a household freshness gate", async () => {
    const stub = env.DB_FRESHNESS.getByName(crypto.randomUUID());
    const response = await stub.fetch(
      new Request("https://example.test/socket", {
        headers: { Upgrade: "websocket" },
      }),
    );
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing subscription socket");
    socket.accept();
    const received = new Promise<string>((resolve) =>
      socket.addEventListener(
        "message",
        (event: MessageEvent) => resolve(String(event.data)),
        { once: true },
      ),
    );
    await evictDurableObject(stub);
    await stub.publishChanges({ task: ["TSK-A3F2"] });
    expect(JSON.parse(await received)).toEqual({
      type: "ring",
      topic: "household.changed",
      changes: { task: ["TSK-A3F2"] },
    });
    socket.close();
  });
});
