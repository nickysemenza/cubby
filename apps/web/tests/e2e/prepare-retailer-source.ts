import { preparePurchaseImportInput } from "@cubby/schemas/purchase-import";
import type { Database } from "~/server/db";
import { preparePurchaseImport } from "~/server/purchase-import/import-orders";
import {
  sha256Hex,
  syntheticOrderIds,
} from "../../tooling/convergence-harness";
import type { E2EWorkerRuntime } from "./e2e-worker-runtime";
import { expect } from "./e2e-test";

const readableText = (html: string) =>
  html
    .replaceAll(/<title>[^<]*<\/title>/gu, "")
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

/**
 * A retailer order a member's caller read from its own pages and extracted:
 * preparation opens the import Run, where it waits for review.
 */
export async function prepareCapturedRetailerOrder(input: {
  db: Database;
  actor: Parameters<typeof preparePurchaseImport>[2];
  runtime: Pick<E2EWorkerRuntime, "googleProvider">;
  targetPurchaseId?: string;
  token: string;
  url: string;
  productUrl: string;
  expectedProductText: string;
  retailerPages: Record<string, string>;
}) {
  const { db, actor, runtime, token, url, productUrl } = input;
  const providerURL = runtime.googleProvider?.url;
  if (!providerURL)
    throw new Error("Retailer extraction requires its local provider");
  const ids = syntheticOrderIds(token);
  const orderHtml = input.retailerPages[url];
  const productHtml = input.retailerPages[productUrl];
  if (orderHtml === undefined || productHtml === undefined)
    throw new Error(
      "Synthetic retailer pages must include the order and product",
    );
  expect(readableText(productHtml)).toContain(input.expectedProductText);
  // The member's own caller reads the retailer page; the server receives only
  // its readable capture, never a browser session.
  const capture = {
    url,
    title: /<title>([^<]*)<\/title>/u.exec(orderHtml)?.[1] ?? "",
    text: readableText(orderHtml),
    capturedAt: new Date().toISOString(),
    links: [...orderHtml.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/gu)].map(
      ([, href, text], index) => ({
        id: `link-${index}`,
        href: href ?? "",
        text: text ?? "",
      }),
    ),
    images: [],
  };
  // The caller extracts its own reading; the server validates and prepares it.
  const response = await fetch(`${providerURL}/model/extract-capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(capture),
  });
  if (!response.ok) throw new Error(await response.text());
  const extraction: unknown = await response.json();
  const checksum = sha256Hex(JSON.stringify({ orderHtml, productHtml }));
  const prepared = await preparePurchaseImport(
    db,
    preparePurchaseImportInput.parse({
      _runExecution: {
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
  return { publicId: prepared.runId };
}
