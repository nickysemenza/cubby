import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { initiateUploadWithoutEntityResponseSchema } from "@cubby/schemas/image";
import { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";

import { productWithFoodOut } from "@cubby/schemas/product";
import {
  productCreateWithInventoryInput,
  productCreateWithInventoryOut,
} from "@cubby/schemas/product-capture";
import type { Request, Response } from "@playwright/test";
import superjson from "superjson";
import { z } from "zod";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { toWire } from "~/lib/http-api/wire";
import { superJsonResultSchema } from "~/lib/superjson-wire";

import { dispatchOperations } from "./dispatch-wire";

import { seedProductPrerequisite } from "./fixtures-catalog";
import { createEntityFixture } from "./fixtures-core";
import {
  gotoAuthenticatedPage,
  reloadAuthenticatedPage,
  uniqueName,
} from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const itemPhoto = fileURLToPath(
  new URL("./fixtures/synthetic-wardrobe-shirt.png", import.meta.url),
);
// The operations observed here are mutations, which always travel alone.
const operationRequest = (request: Request) => {
  const operations = dispatchOperations(request);
  return operations.length === 1 ? operations[0]! : null;
};

const operationResult = async <Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
) => {
  expect(
    response.status(),
    response.ok() ? undefined : scrubErrorMessage(await response.text()),
  ).toBe(200);
  const envelope = z
    .object({ ok: z.literal(true), data: z.unknown() })
    .parse(
      superjson.deserialize(superJsonResultSchema.parse(await response.json())),
    );
  return schema.parse(envelope.data);
};

// Rollback/refused-placement retry belongs to the real-PG command regression.
// This boundary proves the photo client uploads bytes and invokes that command.
test("Photo item uploads a staged image and commits one Product with one each at the reviewed location", async ({
  page,
}, testInfo) => {
  const location = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Synthetic photo capture shelf"),
    type: "shelf",
    parentId: null,
  });
  const existing = await seedProductPrerequisite(page, {
    name: uniqueName(testInfo, "Synthetic existing shelf item"),
  });
  await createEntityFixture(page, "inventory", {
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
    for (const command of dispatchOperations(request))
      operations.push(command.operation);
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
  expect(await uploaded.request().headerValue("content-length")).toBe(
    String(statSync(itemPhoto).size),
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
  const resume = page.getByRole("button", {
    name: "Resume recount",
    exact: true,
  });
  await reloadAuthenticatedPage(page, resume);
  await resume.click();
  await expect(stocked).toBeVisible();

  const productResponse = await page.request.get(
    `/api/v1/products/${committed.product.id}`,
  );
  expect(
    productResponse.status(),
    productResponse.ok()
      ? undefined
      : scrubErrorMessage(await productResponse.text()),
  ).toBe(200);
  const product = toWire(productWithFoodOut, "output").parse(
    await productResponse.json(),
  );
  const inventoryResponse = await page.request.get(
    `/api/v1/inventory/${committed.inventory.id}`,
  );
  expect(
    inventoryResponse.status(),
    inventoryResponse.ok()
      ? undefined
      : scrubErrorMessage(await inventoryResponse.text()),
  ).toBe(200);
  const inventory = toWire(inventoryWithLocationAndProductOut, "output").parse(
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
