import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { z } from "zod";
import {
  browserBridgeResult,
  type BrowserBridgeResult,
  browserBridgeServerMessage,
  browserPageCapture,
} from "@cubby/schemas/purchase-import";
import type { Database } from "~/server/db";
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
  await peer.goto(input.baseURL);
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
    const capture = browserPageCapture.parse(
      await retailer.evaluate(() => ({
        sourceURL: location.href,
        canonicalUrl:
          document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
            ?.href ?? null,
        title: document.title,
        readableText: document.body.innerText,
        links: [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
          .slice(0, 200)
          .map((link, index) => ({
            id: `link-${index}`,
            url: link.href,
            label: link.innerText,
          })),
        images: [...document.querySelectorAll<HTMLImageElement>("img[src]")]
          .slice(0, 200)
          .filter((image) => image.naturalWidth > 0)
          .map((image) => ({
            url: image.src,
            alt: image.alt,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
          })),
        paymentEvidence: [],
        evidence: [],
        capturedAt: new Date().toISOString(),
        captureVersion: 1,
      })),
    );
    return browserBridgeResult.parse({
      protocolVersion: 2,
      commandID: command.id,
      operationID: command.operationId,
      runID: command.runID,
      completedAt: new Date().toISOString(),
      outcome: { status: "completed", capture },
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
                protocolVersion: 2,
                type: "hello",
                deviceID,
                browser: "chrome",
                capabilities: {
                  fixedCaptureVersion: 1,
                  enhancedScreenshot: false,
                  renderedPDF: false,
                },
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
              JSON.stringify({ protocolVersion: 2, type: "result", result }),
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
  await expect.poll(() => broker.connected()).toBe(true);
  return {
    retailer,
    async capture(url: string, operationId: string) {
      await issueBrowserCommand(input.db, input.namespace, {
        runId: input.runId,
        operationId,
        operation: {
          type: "capture",
          recoveryURL: url,
          allowedHosts: [new URL(url).hostname],
          enhancedEvidence: false,
        },
      });
      let capture: z.output<typeof browserPageCapture> | undefined;
      await expect
        .poll(
          async () => {
            const result = await readBrowserCommandResult(
              input.db,
              input.namespace,
              { runId: input.runId, operationId },
            );
            if (
              result.state === "completed" &&
              result.result.outcome.status === "completed"
            )
              capture = result.result.outcome.capture ?? undefined;
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
