import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { z } from "zod";
import {
  BROWSER_BRIDGE_PROTOCOL,
  browserBridgeResult,
  type BrowserBridgeResult,
  browserBridgeServerMessage,
  browserPageCapture,
} from "@cubby/schemas/purchase-import";
import type { Database } from "~/server/db";
import { encodeSnapshotDom } from "~/server/purchase-import/browser-page";
import {
  observation,
  testBrowserPorts,
} from "~/server/purchase-import/browser.fixtures";
import {
  issueBrowserCommand,
  readBrowserCommandResult,
  type PurchaseImportNamespace,
} from "~/server/purchase-import/run-service";
import { expect } from "./e2e-test";

type BrowserBridgeServerMessage = z.infer<typeof browserBridgeServerMessage>;

declare global {
  interface Window {
    syntheticBrowserCommand(
      message: BrowserBridgeServerMessage,
    ): Promise<BrowserBridgeResult | null>;
  }
}

/** Chromium supplies the external browser adapter; the authenticated socket,
 * command ownership, durable queue, result persistence and recovery are live. */
export async function connectRetailerBrowserPeer(input: {
  page: Page;
  db: Database;
  namespace: PurchaseImportNamespace;
  baseURL: string;
  accountCode: string;
  accountId: string;
  runId: string;
  retailerPages: Readonly<Record<string, string>>;
}) {
  const peer = await input.page.context().newPage();
  const retailer = await input.page.context().newPage();
  // Context interception disables HTTP caching for unrelated Cubby pages.
  // Keep synthetic external documents on the retailer page alone.
  for (const [url, html] of Object.entries(input.retailerPages)) {
    await retailer.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
  }
  // The socket needs a same-origin document and session cookies; this peer
  // captures no app DOM. The separate retailer page owns the real capture.
  await peer.goto(new URL("/api/auth/get-session", input.baseURL).href);
  await peer.exposeFunction("syntheticBrowserCommand", async (raw: unknown) => {
    const message = browserBridgeServerMessage.parse(raw);
    if (message.type !== "command") return null;
    const command = message.command;
    const operation = command.operation;
    if (operation.type !== "capture" || !operation.recoveryURL)
      throw new Error("Synthetic browser expects a bounded recovery capture");
    if (
      !operation.allowedHosts.includes(new URL(operation.recoveryURL).hostname)
    )
      throw new Error("Retailer recovery escaped the production allowlist");
    await retailer.goto(operation.recoveryURL);
    // Like the Mac: send the rendered DOM; the server derives the page.
    const page = await retailer.evaluate(() => ({
      sourceURL: location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
    }));
    return browserBridgeResult.parse({
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
      commandID: command.id,
      operationID: command.operationId,
      runID: command.runID,
      completedAt: new Date().toISOString(),
      outcome: {
        status: "completed",
        snapshot: {
          sourceURL: page.sourceURL,
          title: page.title,
          capturedAt: new Date().toISOString(),
          dom: await encodeSnapshotDom(page.html),
          screenshot: { status: "skipped" },
        },
        observation: observation({ url: page.sourceURL, title: page.title }),
      },
    });
  });
  await peer.evaluate(
    async ({ baseURL, accountCode, deviceID }) => {
      const url = new URL("/api/import/agent/socket", baseURL);
      url.protocol = "ws:";
      url.searchParams.set("vendorAccount", accountCode);
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          "error",
          () => reject(new Error("Authenticated browser socket failed")),
          { once: true },
        );
        socket.addEventListener(
          "open",
          () => {
            socket.send(
              JSON.stringify({
                protocolVersion: 3,
                type: "hello",
                deviceID,
                browser: "chrome",
                capabilities: { snapshotVersion: 1, screenshot: false },
              }),
            );
            resolve();
          },
          { once: true },
        );
        socket.addEventListener("message", async (event) => {
          const message: BrowserBridgeServerMessage = JSON.parse(
            String(event.data),
          );
          const result = await window.syntheticBrowserCommand(message);
          if (result)
            socket.send(
              JSON.stringify({ protocolVersion: 3, type: "result", result }),
            );
        });
      });
    },
    {
      baseURL: input.baseURL,
      accountCode: input.accountCode,
      deviceID: randomUUID(),
    },
  );
  const broker = input.namespace.getByName(input.accountId);
  // Evidence stays in memory and the server never reads the synthetic
  // retailer itself, so every page goes through the browser peer.
  const ports = testBrowserPorts();
  await expect.poll(() => broker.connected()).toBe(true);
  return {
    retailer,
    async capture(url: string, operationId: string) {
      await issueBrowserCommand(
        input.db,
        input.namespace,
        {
          runId: input.runId,
          operationId,
          operation: {
            type: "capture",
            recoveryURL: url,
            allowedHosts: [new URL(url).hostname],
            screenshot: "preferred",
          },
        },
        ports,
      );
      let capture: z.output<typeof browserPageCapture> | undefined;
      await expect
        .poll(
          async () => {
            const result = await readBrowserCommandResult(
              input.db,
              input.namespace,
              { runId: input.runId, operationId },
              ports,
            );
            if (result.state === "completed" && result.capture)
              capture = result.capture;
            return Boolean(capture);
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      return browserPageCapture.parse(capture);
    },
    async close() {
      await peer.close();
      await retailer.close();
    },
  };
}
