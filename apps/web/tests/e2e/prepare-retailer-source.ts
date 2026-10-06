import type { Page } from "@playwright/test";
import { preparePurchaseImportInput } from "@cubby/schemas/purchase-import";
import type { Database } from "~/server/db";
import { preparePurchaseImport } from "~/server/purchase-import/import-orders";
import { extractPurchaseCapture } from "~/server/agents/purchase-import/extract";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import {
  sha256Hex,
  syntheticOrderIds,
} from "../../tooling/convergence-harness";
import { connectRetailerBrowserPeer } from "./retailer-browser-peer";
import type { E2EWorkerRuntime } from "./e2e-worker-runtime";
import { expect } from "./e2e-test";

/** External pages/model responses enter the production broker, capture, extraction and preparation. */
export async function prepareCapturedRetailerOrder(input: {
  page: Page;
  db: Database;
  actor: Parameters<typeof preparePurchaseImport>[2];
  runtime: Pick<
    E2EWorkerRuntime,
    "baseURL" | "browserNamespace" | "googleProvider"
  >;
  ledgerPartyId: Parameters<typeof startOrResumeRun>[1]["ledgerPartyId"];
  vendorAccountId: NonNullable<
    Parameters<typeof startOrResumeRun>[1]["vendorAccountId"]
  >;
  accountCode: string;
  targetPurchaseId?: string;
  token: string;
  url: string;
  productUrl: string;
  expectedProductText: string;
  retailerPages: Parameters<
    typeof connectRetailerBrowserPeer
  >[0]["retailerPages"];
}) {
  const { page, db, actor, runtime, token, url, productUrl } = input;
  const providerURL = runtime.googleProvider?.url;
  if (!providerURL)
    throw new Error("Retailer extraction requires its local provider");
  const run = await startOrResumeRun(db, {
    ledgerPartyId: input.ledgerPartyId,
    vendorAccountId: input.vendorAccountId,
    trigger: "manual",
  });
  const namespace = await runtime.browserNamespace();
  const peer = await connectRetailerBrowserPeer({
    page,
    db,
    namespace,
    baseURL: runtime.baseURL,
    accountCode: input.accountCode,
    accountId: input.vendorAccountId,
    runId: run.id,
    retailerPages: input.retailerPages,
  });
  const ids = syntheticOrderIds(token);
  try {
    const captured = await peer.capture(url, `capture-order:${token}`);
    const capturedProduct = await peer.capture(
      productUrl,
      `capture-product:${token}`,
    );
    expect(capturedProduct.readableText).toContain(input.expectedProductText);
    const capture = {
      url: captured.sourceURL,
      title: captured.title,
      text: captured.readableText,
      capturedAt: captured.capturedAt,
      links: captured.links.map((link) => ({
        id: link.id,
        href: link.url,
        text: link.label ?? "",
      })),
      images: captured.images.map((image) => ({
        src: image.url,
        alt: image.alt ?? "",
      })),
    };
    const extraction = await extractPurchaseCapture(
      { db, runId: run.id, capture },
      {
        runStructured: async (feature) => {
          const response = await fetch(`${providerURL}/model/extract-capture`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(capture),
          });
          if (!response.ok) throw new Error(await response.text());
          return feature.schema.parse(await response.json());
        },
      },
    );
    const checksum = sha256Hex(JSON.stringify({ captured, capturedProduct }));
    await preparePurchaseImport(
      db,
      preparePurchaseImportInput.parse({
        _runExecution: {
          runId: run.id,
          operationId: ids.prepare,
          itemOperationIds: [ids.item],
        },
        orders: [
          {
            targetPurchaseId: input.targetPurchaseId,
            stableOrderId: ids.order,
            itemOperationId: ids.item,
            source: { kind: "browser_order", externalKey: url, checksum },
            evidenceChecksum: checksum,
            extractionRevision: "synthetic-provider@1",
            extraction,
            lineIds: [ids.line],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      }),
      actor,
    );
  } finally {
    await peer.close();
  }
  return run;
}
