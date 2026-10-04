import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { initiateUploadWithoutEntityResponseSchema } from "@cubby/schemas/image";
import { inventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import { productWithFoodOut } from "@cubby/schemas/product";
import { productCreateWithInventoryOut } from "@cubby/schemas/product-capture";
import { scanAtLocationOut } from "@cubby/schemas/scan";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared/constants";
import type { APIResponse, Page } from "@playwright/test";
import { z } from "zod";

import { toWire } from "~/lib/http-api/wire";

import { expect, test } from "./e2e-test";
import { uniqueName } from "./e2e-helpers";
import { seedProductPrerequisite } from "./fixtures-catalog";
import { createEntityFixture } from "./fixtures-core";

// The native app owns scan, recount, sweep, and the location photo pass; the
// web screens that used to exercise these endpoints are gone. These tests keep
// the server contracts the app calls observable at the HTTP boundary.
// Transaction rollback and refused-placement retries stay in the real-PG
// command regressions.

const itemPhoto = fileURLToPath(
  new URL("./fixtures/synthetic-wardrobe-shirt.png", import.meta.url),
);

const jsonBody = z.json();
type JsonBody = z.infer<typeof jsonBody>;

async function post(
  page: Page,
  baseURL: string | undefined,
  path: string,
  data: JsonBody,
) {
  return page.request.post(`/api/v1/${path}`, {
    headers: { Origin: baseURL ?? "" },
    data,
  });
}

async function json(response: APIResponse) {
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

test("a staged photo and reviewed placement commit one Product with one each", async ({
  page,
  baseURL,
}, testInfo) => {
  const location = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Synthetic capture shelf"),
    type: "shelf",
    parentId: null,
  });
  const name = uniqueName(testInfo, "Synthetic capture clamp");

  const staged = toWire(
    initiateUploadWithoutEntityResponseSchema,
    "output",
  ).parse(
    await json(
      await post(page, baseURL, "image/uploadImage", {
        filename: "synthetic-wardrobe-shirt.png",
        contentType: "image/png",
        size: statSync(itemPhoto).size,
        entityKind: "PRODUCT",
      }),
    ),
  );
  const uploaded = await page.request.put(staged.uploadUrl, {
    data: readFileSync(itemPhoto),
    headers: { "content-type": "image/png" },
  });
  expect(uploaded.ok()).toBe(true);

  const committed = toWire(productCreateWithInventoryOut, "output").parse(
    await json(
      await post(page, baseURL, "product/createWithInventory", {
        product: {
          name: `misc: ${name}`,
          manufacturer: UNSPECIFIED_MANUFACTURER,
          pendingImageIds: [staged.imageId],
        },
        inventory: {
          locationId: location.id,
          placement: "stock",
          amount: { value: 1, unit: "each" },
        },
      }),
    ),
  );
  expect(committed.product.images.map((image) => image.id)).toEqual([
    staged.imageId,
  ]);
  expect(committed.inventory.amount).toEqual({ value: 1, unit: "each" });

  const product = toWire(productWithFoodOut, "output").parse(
    await json(
      await page.request.get(`/api/v1/products/${committed.product.id}`),
    ),
  );
  const inventory = toWire(inventoryWithLocationAndProductOut, "output").parse(
    await json(
      await page.request.get(`/api/v1/inventory/${committed.inventory.id}`),
    ),
  );
  expect(product.inventoryEntry.map((entry) => entry.id)).toEqual([
    inventory.id,
  ]);
  expect(inventory).toMatchObject({
    product: { id: product.id },
    location: { id: location.id },
    amount: { value: 1, unit: "each" },
    placement: "stock",
  });
});

// Regression: a re-sweep of a correct shelf must confirm, never increment.
test("scanning a product already on the shelf confirms it without changing its amount", async ({
  page,
  baseURL,
}, testInfo) => {
  const location = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Synthetic sweep shelf"),
    type: "shelf",
    parentId: null,
  });
  const product = await seedProductPrerequisite(page, {
    name: uniqueName(testInfo, "Synthetic sweep level"),
  });
  const entry = await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 2, unit: "each" },
    placement: "stock",
  });

  for (const _ of [1, 2]) {
    const result = toWire(scanAtLocationOut, "output").parse(
      await json(
        await post(page, baseURL, "inventory/scanAtLocation", {
          locationId: location.id,
          code: { kind: "product", value: product.id },
        }),
      ),
    );
    expect(result.outcome).toBe("confirmed");
    expect(result.strays).toEqual([]);
  }

  const after = toWire(inventoryWithLocationAndProductOut, "output").parse(
    await json(await page.request.get(`/api/v1/inventory/${entry.id}`)),
  );
  expect(after.amount).toEqual({ value: 2, unit: "each" });
});

test("a recount commits its resolutions against the loaded snapshot and refuses a stale one", async ({
  page,
  baseURL,
}, testInfo) => {
  const location = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Synthetic recount bin"),
    type: "shelf",
    parentId: null,
  });
  const product = await seedProductPrerequisite(page, {
    name: uniqueName(testInfo, "Synthetic recount wrench"),
  });
  const entry = await createEntityFixture(page, "inventory", {
    productId: product.id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
    placement: "stock",
  });

  const snapshot = await json(
    await page.request.get(
      `/api/v1/inventory/locationSnapshot?locationId=${location.id}`,
    ),
  );
  const payload = {
    locationId: location.id,
    expectedInventoryEntryIds: [entry.id],
    snapshotToken: snapshot.snapshotToken,
    resolutions: [{ inventoryEntryId: entry.id, kind: "verify" }],
  };

  const committed = await post(
    page,
    baseURL,
    "inventory/reconcileSession",
    payload,
  );
  expect(committed.status(), await committed.text()).toBe(200);

  // Another device stocked this bin after the snapshot was taken.
  await createEntityFixture(page, "inventory", {
    productId: (
      await seedProductPrerequisite(page, {
        name: uniqueName(testInfo, "Synthetic recount late arrival"),
      })
    ).id,
    locationId: location.id,
    amount: { value: 1, unit: "each" },
    placement: "stock",
  });
  const stale = await post(
    page,
    baseURL,
    "inventory/reconcileSession",
    payload,
  );
  expect(stale.ok()).toBe(false);
});
