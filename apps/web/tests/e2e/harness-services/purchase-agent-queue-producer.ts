/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- This workerd-only transport shim receives Cloudflare Queue and WebSocket wire payloads. */
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
    if (url.pathname !== "/browser-connect")
      return new Response("Not found", { status: 404 });

    // One simulated Mac browser for a vendor account. It stays connected and
    // answers every command the broker dispatches, by the URL the command
    // names, so a run can issue several commands over one connection.
    const input = (await request.json()) as {
      vendorAccountId: string;
      ledgerPartyId: string;
      userId: string;
      outcomes?: Record<string, unknown>;
      /** Capture latency before each result, as a real browser takes. */
      delayMs?: number;
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
        command?: {
          id: string;
          operationId: string;
          runID: string;
          operation: { url?: string; recoveryURL?: string };
        };
      };
      if (message.type !== "command" || !message.command) return;
      const command = message.command;
      const target = command.operation.recoveryURL ?? command.operation.url;
      const reply = () =>
        socket.send(
          JSON.stringify({
            protocolVersion: 3,
            type: "result",
            result: {
              protocolVersion: 3,
              commandID: command.id,
              operationID: command.operationId,
              runID: command.runID,
              completedAt: new Date().toISOString(),
              // Navigate, scroll, and window commands carry no page.
              outcome: (target && input.outcomes?.[target]) ?? {
                status: "completed",
                snapshot: null,
                observation: {
                  url: target ?? null,
                  title: null,
                  readyState: "complete",
                  window: {
                    recovered: false,
                    minimized: false,
                    onScreen: true,
                  },
                  screenRecording: "granted",
                  durationMs: 1,
                },
              },
            },
          }),
        );
      if (input.delayMs) setTimeout(reply, input.delayMs);
      else reply();
    });
    socket.send(
      JSON.stringify({
        protocolVersion: 3,
        type: "hello",
        deviceID: "11111111-1111-4111-8111-111111111111",
        browser: "chrome",
        capabilities: { snapshotVersion: 1, screenshot: true },
      }),
    );
    return new Response(null, { status: 202 });
  },
};
