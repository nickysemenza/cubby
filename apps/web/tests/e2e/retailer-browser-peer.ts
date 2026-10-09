import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  BROWSER_BRIDGE_PROTOCOL,
  browserBridgeResult,
  browserBridgeClientMessage,
  browserBridgeServerMessage,
  browserPageCapture,
} from "@cubby/schemas/purchase-import";
import type { Database } from "~/server/db";
import { runOperation } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { runEntityId } from "@cubby/schemas/identifiers";
import { browserCommandRecord } from "~/server/purchase-import/browser-results";
import {
  acknowledgeResearchBrowserObservation,
  researchBrowserFor,
} from "~/server/purchase-import/research-browser-service";
import { retainedResearchObservation } from "@cubby/schemas/research";
import type { E2EBrowserNamespace } from "./e2e-worker-runtime";
import { encodeSnapshotDom } from "~/server/purchase-import/browser-page";
import {
  observation,
  testBrowserPorts,
} from "~/server/purchase-import/browser.fixtures";
import { expect } from "./e2e-test";

type BrowserBridgeClientMessage = z.infer<typeof browserBridgeClientMessage>;

declare global {
  interface Window {
    syntheticBrowserCommand(
      message: string,
    ): Promise<BrowserBridgeClientMessage | null>;
  }
}

/** Chromium supplies the external browser adapter; the authenticated socket,
 * command ownership, durable queue, result persistence and recovery are live. */
export async function connectRetailerBrowserPeer(input: {
  page: Page;
  db: Database;
  namespace: E2EBrowserNamespace;
  baseURL: string;
  accountCode: string;
  accountId: string;
  runId: string;
  workRef: string;
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
  const deviceID = randomUUID();
  await peer.exposeFunction("syntheticBrowserCommand", async (raw: string) => {
    const message = browserBridgeServerMessage.parse(JSON.parse(raw));
    if (message.type === "ping")
      return browserBridgeClientMessage.parse({
        protocolVersion: BROWSER_BRIDGE_PROTOCOL,
        type: "pong",
        timestamp: message.timestamp,
      });
    if (message.type === "forget_run")
      return browserBridgeClientMessage.parse({
        protocolVersion: BROWSER_BRIDGE_PROTOCOL,
        type: "forget_run_ack",
        runID: message.runID,
        retirementID: message.retirementID,
        deviceID,
      });
    if (message.type === "run_completed")
      return browserBridgeClientMessage.parse({
        protocolVersion: BROWSER_BRIDGE_PROTOCOL,
        type: "run_completed_ack",
        runID: message.runID,
      });
    if (message.type !== "command") return null;
    const command = message.command;
    const operation = command.operation;
    if (operation.type !== "navigate" && operation.type !== "read")
      throw new Error(
        "Synthetic browser expects an explicit navigation or read",
      );
    const url = operation.type === "navigate" ? operation.url : retailer.url();
    if (!operation.allowedHosts.includes(new URL(url).hostname))
      throw new Error("Retailer navigation escaped the production allowlist");
    if (operation.type === "navigate") await retailer.goto(operation.url);
    // Like the Mac: send the rendered DOM; the server derives the page.
    const page = await retailer.evaluate(() => ({
      sourceURL: location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
    }));
    const result = browserBridgeResult.parse({
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
      commandID: command.id,
      operationID: command.operationId,
      runID: command.runID,
      completedAt: new Date().toISOString(),
      outcome: {
        status: "completed",
        snapshot: {
          observationId: randomUUID(),
          servedURL: page.sourceURL,
          actions: [],
          actionsTruncated: false,
          sourceURL: page.sourceURL,
          title: page.title,
          capturedAt: new Date().toISOString(),
          dom: await encodeSnapshotDom(page.html),
          screenshot: { status: "skipped" },
        },
        observation: observation({ url: page.sourceURL, title: page.title }),
      },
    });
    return browserBridgeClientMessage.parse({
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
      type: "result",
      result,
    });
  });
  await peer.evaluate(
    async ({ baseURL, accountCode, deviceID, protocolVersion }) => {
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
                protocolVersion,
                type: "hello",
                deviceID,
                browser: "chrome",
                capabilities: {
                  snapshotVersion: 1,
                  screenshot: false,
                  actions: ["navigate", "read"],
                },
              }),
            );
            resolve();
          },
          { once: true },
        );
        socket.addEventListener("message", async (event) => {
          const message = String(event.data);
          const response = await window.syntheticBrowserCommand(message);
          if (response) socket.send(JSON.stringify(response));
        });
      });
    },
    {
      baseURL: input.baseURL,
      accountCode: input.accountCode,
      deviceID,
      protocolVersion: BROWSER_BRIDGE_PROTOCOL,
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
      const browser = researchBrowserFor(
        input.db,
        {
          R2_KEY_PREFIX: "synthetic/retailer",
          PURCHASE_IMPORT: input.namespace,
        },
        input.runId,
        ports,
      );
      const admitted = await browser.observe(
        { workRef: input.workRef, action: { kind: "navigate", url } },
        operationId,
      );
      expect(admitted).toMatchObject({
        status: "waiting",
        workRef: input.workRef,
      });
      const readRecord = async () => {
        const [operation] = await getDb(input.db)
          .select({ result: runOperation.result })
          .from(runOperation)
          .where(
            and(
              eq(runOperation.runId, runEntityId.parse(input.runId)),
              eq(runOperation.operationId, operationId),
            ),
          );
        if (!operation)
          throw new Error("Retailer command was not durably admitted");
        return browserCommandRecord.parse(operation.result);
      };
      const issued = await readRecord();
      const signal = {
        type: "purchase-import.browser_result",
        body: JSON.stringify({
          commandId: issued.commandId,
          eventId: `browser-result:${issued.commandId}`,
        }),
      };
      await expect
        .poll(async () => Boolean(await broker.result(issued.commandId)), {
          timeout: 30_000,
        })
        .toBe(true);
      const resumed = retainedResearchObservation.parse(
        await browser.resume(signal),
      );
      const materialized = await readRecord();
      if (!materialized.page)
        throw new Error("Retailer result has no retained capture");
      expect(materialized.workRef).toBe(input.workRef);
      expect(resumed.evidenceId).toBe(materialized.page.domEvidenceId);
      expect(materialized.page.capture.sourceURL).toBe(url);
      await acknowledgeResearchBrowserObservation(
        input.db,
        input.runId,
        signal,
      );
      const beforeReplay = await readRecord();
      expect(
        await browser.observe(
          { workRef: input.workRef, action: { kind: "navigate", url } },
          operationId,
        ),
      ).toMatchObject(resumed);
      expect(await readRecord()).toEqual(beforeReplay);
      return browserPageCapture.parse(materialized.page.capture);
    },
    async close() {
      await peer.close();
      await retailer.close();
    },
  };
}
