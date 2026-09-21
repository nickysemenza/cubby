/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- This workerd-only transport shim receives Cloudflare Queue and WebSocket wire payloads. */
import type {
  DurableObjectNamespace,
  MessageEvent as CfMessageEvent,
  WebSocket as CfWebSocket,
} from "@cloudflare/workers-types";

const activeBrowserSockets = new Set<CfWebSocket>();

export default {
  async fetch(
    request: Request,
    env: {
      PURCHASE_AGENT_QUEUE: { send(message: unknown): Promise<void> };
      PURCHASE_IMPORT_CLIENT: DurableObjectNamespace;
    },
  ) {
    const url = new URL(request.url);
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/dispatch") {
      await env.PURCHASE_AGENT_QUEUE.send(await request.json());
      return new Response(null, { status: 202 });
    }
    if (url.pathname !== "/browser-result")
      return new Response("Not found", { status: 404 });

    const input = (await request.json()) as {
      vendorAccountId: string;
      ledgerPartyId: string;
      userId: string;
      runId: string;
      commandId: string;
      operationId: string;
    };
    const response = await env.PURCHASE_IMPORT_CLIENT.getByName(
      input.vendorAccountId,
    ).fetch(new URL("https://broker.test/socket"), {
      headers: {
        Upgrade: "websocket",
        "x-cubby-ledger-party-id": input.ledgerPartyId,
        "x-cubby-vendor-account-id": input.vendorAccountId,
        "x-cubby-user-id": input.userId,
      },
    });
    const socket = response.webSocket;
    if (!socket) return new Response("Broker upgrade failed", { status: 502 });
    socket.accept();
    activeBrowserSockets.add(socket);
    socket.addEventListener("close", () => activeBrowserSockets.delete(socket));

    socket.addEventListener("message", (event: CfMessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        command?: { id?: string };
        commandID?: string;
      };
      if (message.type !== "command") return;
      if (message.command?.id !== input.commandId) {
        activeBrowserSockets.delete(socket);
        socket.close(1008, "broker dispatched the wrong command");
        return;
      }
      socket.send(
        JSON.stringify({
          protocolVersion: 2,
          type: "result",
          result: {
            protocolVersion: 2,
            commandID: input.commandId,
            operationID: input.operationId,
            runID: input.runId,
            completedAt: new Date().toISOString(),
            outcome: { status: "completed" },
          },
        }),
      );
    });
    socket.send(
      JSON.stringify({
        protocolVersion: 2,
        type: "hello",
        deviceID: "11111111-1111-4111-8111-111111111111",
        browser: "chrome",
        capabilities: {
          fixedCaptureVersion: 1,
          enhancedScreenshot: false,
          renderedPDF: true,
        },
      }),
    );
    return new Response(null, { status: 202 });
  },
};
