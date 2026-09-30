import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { initiateUploadWithoutEntityResponseSchema } from "@cubby/schemas/image";
import { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import { locationCreateInput } from "@cubby/schemas/location";
import { productWithFoodOut } from "@cubby/schemas/product";
import {
  productCreateWithInventoryInput,
  productCreateWithInventoryOut,
} from "@cubby/schemas/product-capture";
import type { Request, Response } from "@playwright/test";
import superjson from "superjson";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { superJsonResultSchema } from "~/lib/superjson-wire";

import { createFixture, seedProductPrerequisite } from "./e2e-fixtures";
import {
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const itemPhoto = fileURLToPath(
  new URL("./fixtures/synthetic-wardrobe-shirt.png", import.meta.url),
);
const dispatchInput = z.object({
  operation: z.string(),
  input: z.unknown().optional(),
});
const operationRequest = (request: Request) =>
  request.method() === "POST" &&
  new URL(request.url()).pathname === BROWSER_OPERATION_PATH
    ? dispatchInput.parse(
        superjson.deserialize(
          superJsonResultSchema.parse(request.postDataJSON()),
        ),
      )
    : null;

const operationResult = async <Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
) => {
  expect(
    response.status(),
    response.ok() ? undefined : scrubErrorMessage(await response.text()),
  ).toBe(200);
  return z
    .object({ ok: z.literal(true), data: schema })
    .parse(
      superjson.deserialize(superJsonResultSchema.parse(await response.json())),
    ).data;
};

// Rollback/refused-placement retry belongs to the real-PG command regression.
// This boundary proves the photo client uploads bytes and invokes that command.
test("Photo item uploads a staged image and commits one Product with one each at the reviewed location", async ({
  page,
}, testInfo) => {
  const location = await createFixture(
    page,
    "location",
    locationCreateInput.parse({
      name: uniqueName(testInfo, "Synthetic photo capture shelf"),
      type: "shelf",
      parentId: null,
      aliases: [],
      tags: [],
    }),
  );
  const existing = await seedProductPrerequisite(page, {
    name: uniqueName(testInfo, "Synthetic existing shelf item"),
  });
  await createFixture(page, "inventory", {
    productId: existing.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
    placement: "stock",
  });
  const name = uniqueName(testInfo, "Synthetic photo capture clamp");
  const addHere = page.getByRole("button", { name: /Add something here/ });
  await gotoAuthenticatedPage(
    page,
    `/inventory/session?parent=${location.id}`,
    addHere,
  );
  await addHere.click();
  const capture = page.getByRole("dialog", {
    name: "Add something here",
    exact: true,
  });
  const fileChooser = page.waitForEvent("filechooser");
  await capture
    .getByRole("button", { name: "Photo item", exact: true })
    .click();
  const chooser = await fileChooser;
  const input = chooser.element();
  expect(await input.getAttribute("capture")).toBe("environment");
  await input.setInputFiles(itemPhoto);
  const naming = page.getByRole("dialog", {
    name: "Name this item",
    exact: true,
  });
  await expect(naming).toBeVisible();
  await naming.getByRole("textbox").fill(name);

  const operations: string[] = [];
  const recordOperation = (request: Request) => {
    const command = operationRequest(request);
    if (command) operations.push(command.operation);
  };
  page.on("request", recordOperation);
  const stagedResponse = page.waitForResponse(
    (response) =>
      operationRequest(response.request())?.operation === "image.uploadImage",
  );
  const uploadedResponse = page.waitForResponse(
    (response) => response.request().method() === "PUT",
  );
  const committedResponse = page.waitForResponse(
    (response) =>
      operationRequest(response.request())?.operation ===
      "product.createWithInventory",
  );
  await naming.getByRole("button", { name: "Add", exact: true }).click();
  const staged = await operationResult(
    await stagedResponse,
    initiateUploadWithoutEntityResponseSchema,
  );
  const uploaded = await uploadedResponse;
  // Never emit the presigned URL (credential-bearing query) into diagnostics.
  expect(uploaded.url() === staged.uploadUrl).toBe(true);
  expect(uploaded.ok()).toBe(true);
  expect(uploaded.request().headers()["content-type"]).toBe("image/png");
  expect(uploaded.request().postDataBuffer()?.byteLength).toBe(
    statSync(itemPhoto).size,
  );

  const response = await committedResponse;
  const command = operationRequest(response.request());
  const reviewed = productCreateWithInventoryInput.parse(command?.input);
  expect(reviewed.product.pendingImageIds).toEqual([staged.imageId]);
  expect(reviewed.inventory).toMatchObject({
    locationId: location.id,
    placement: "stock",
    amount: { value: 1, unit: "each" },
  });
  const committed = await operationResult(
    response,
    productCreateWithInventoryOut,
  );
  expect(committed.product.name).toBe(`misc: ${name}`);
  expect(committed.product.images.map((image) => image.id)).toEqual([
    staged.imageId,
  ]);
  expect(committed.product.inventoryEntry.map((entry) => entry.id)).toEqual([
    committed.inventory.id,
  ]);
  expect(committed.inventory.amount).toEqual({ value: 1, unit: "each" });
  await expect(naming).not.toBeVisible();
  await page.keyboard.press("Escape");
  const stocked = page.getByRole("button", {
    name: `Change ${committed.product.name}`,
    exact: true,
  });
  await expect(stocked).toBeVisible();
  await reloadAuthenticatedPage(page, stocked);

  const productResponse = await page.request.get(
    `/api/v1/products/${committed.product.id}`,
  );
  expect(
    productResponse.status(),
    productResponse.ok()
      ? undefined
      : scrubErrorMessage(await productResponse.text()),
  ).toBe(200);
  const product = productWithFoodOut.parse(await productResponse.json());
  const inventoryResponse = await page.request.get(
    `/api/v1/inventory/${committed.inventory.id}`,
  );
  expect(
    inventoryResponse.status(),
    inventoryResponse.ok()
      ? undefined
      : scrubErrorMessage(await inventoryResponse.text()),
  ).toBe(200);
  const inventory = inventoryWithLocationAndProductOut.parse(
    await inventoryResponse.json(),
  );
  expect(product.images.map((image) => image.id)).toEqual([staged.imageId]);
  expect(product.inventoryEntry.map((entry) => entry.id)).toEqual([
    inventory.id,
  ]);
  expect(inventory).toMatchObject({
    product: { id: product.id },
    location: { id: location.id },
    amount: { value: 1, unit: "each" },
    placement: "stock",
  });
  expect(
    operations.filter((operation) => operation === "image.uploadImage"),
  ).toHaveLength(1);
  expect(
    operations.filter(
      (operation) => operation === "product.createWithInventory",
    ),
  ).toHaveLength(1);
  expect(operations).not.toContain("product.quickCreate");
  page.off("request", recordOperation);

  await gotoAuthenticatedPage(
    page,
    `/products/${product.id}`,
    page.getByRole("heading", { name: product.name, exact: true }),
  );
  const photo = page
    .locator("#images")
    .getByRole("img", { name: "synthetic-wardrobe-shirt.png", exact: true });
  await expect(photo).toBeVisible();
  await expect
    .poll(() =>
      photo.evaluate((element) =>
        element instanceof HTMLImageElement ? element.naturalWidth : 0,
      ),
    )
    .toBeGreaterThan(0);
});
