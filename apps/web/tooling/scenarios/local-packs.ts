import { readFile } from "node:fs/promises";
import { ingredientCreateInput } from "@cubby/schemas/ingredient";
import { initiateUploadWithoutEntityResponseSchema } from "@cubby/schemas/image";
import { locationCreateInput } from "@cubby/schemas/location";
import { plantCreateInput } from "@cubby/schemas/plant";
import { plantingCreateInput } from "@cubby/schemas/planting";
import { productCreateInput } from "@cubby/schemas/product";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { recipeCreateInput } from "@cubby/schemas/recipe";
import { testUserId } from "@cubby/schemas/testing";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { request } from "@playwright/test";
import type { Pool } from "pg";
import { DEV_USER_EMAIL, DEV_USER_PASSWORD } from "../dev-db-identity";
import type { LocalFixturePack } from "../dev-db-seed";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "./context";

/** Optional packs use the entity kernel, keeping the existing E2E corpus stable. */
export async function seedLocalFixturePack(
  pool: Pool,
  userId: string,
  pack: Exclude<LocalFixturePack, "core">,
  baseURL: string,
): Promise<void> {
  const context = buildKernelContext(
    buildScenarioDatabase(pool),
    testUserId(userId),
  );
  switch (pack) {
    case "recipes": {
      const ingredient = await createFixtureWithContext(
        context,
        "ingredient",
        ingredientCreateInput.parse({
          name: "Synthetic rolled oats",
          aliases: [],
        }),
      );
      await createFixtureWithContext(
        context,
        "recipe",
        recipeCreateInput.parse({
          name: "Synthetic breakfast oats",
          meta: { url: "https://example.com/recipes/oats" },
          servings: 2,
          sections: [
            {
              ingredients: [
                {
                  type: "ingredient",
                  ingredientId: ingredient.id,
                  recipeId: null,
                  amounts: [{ value: 100, unit: "g" }],
                },
              ],
              instructions: [
                { instruction: "Simmer the oats in water until tender." },
              ],
            },
          ],
        }),
      );
      return;
    }
    case "garden": {
      const location = await createFixtureWithContext(
        context,
        "location",
        locationCreateInput.parse({
          name: "Synthetic raised bed",
          type: "room",
          aliases: [],
          tags: [],
          parentId: null,
        }),
      );
      const plant = await createFixtureWithContext(
        context,
        "plant",
        plantCreateInput.parse({
          name: "Synthetic leafy lettuce",
          gardenGuideKey: "lettuce",
        }),
      );
      await createFixtureWithContext(
        context,
        "planting",
        plantingCreateInput.parse({
          plantId: plant.id,
          locationId: location.id,
          status: "planned",
          plannedWindow: "Autumn",
          quantity: "Six starts",
        }),
      );
      return;
    }
    case "calendar": {
      const today = new Date().toISOString().slice(0, 10);
      const project = await createFixtureWithContext(
        context,
        "project",
        projectCreateInput.parse({
          name: "Synthetic seasonal maintenance",
          startDate: today,
          endDate: today,
        }),
      );
      await createFixtureWithContext(
        context,
        "task",
        taskCreateInput.parse({
          name: "Synthetic calendar inspection",
          trade: "other",
          dueDate: today,
          projectId: project.id,
        }),
      );
      await createFixtureWithContext(
        context,
        "expense",
        expenseCreateInput.parse({
          name: "Synthetic planned supplies",
          cost: 12.5,
          date: today,
          future: true,
          trade: "other",
          costType: "materials",
          projectId: project.id,
        }),
      );
      return;
    }
    case "purchase": {
      const vendor = await createFixtureWithContext(
        context,
        "vendor",
        vendorCreateInput.parse({
          name: "Synthetic Fixture Shop",
          aliases: [],
          tags: [],
          website: "https://example.com",
        }),
      );
      const purchase = await createFixtureWithContext(
        context,
        "purchase",
        purchaseCreateInput.parse({
          vendorId: vendor.id,
          orderId: "SYNTHETIC-ORDER-001",
          date: "2026-09-01",
          statedTotal: 24,
          pendingImageIds: [],
        }),
      );
      await createFixtureWithContext(
        context,
        "expense",
        expenseCreateInput.parse({
          name: "Synthetic purchase line",
          cost: 24,
          date: "2026-09-01",
          trade: "other",
          costType: "materials",
          purchaseId: purchase.id,
        }),
      );
      return;
    }
    case "problems": {
      const { seedLocalProblemWork } = await import("./local-problem-work");
      await seedLocalProblemWork(pool, userId, baseURL);
      await createFixtureWithContext(
        context,
        "product",
        productCreateInput.parse({
          name: "Synthetic incomplete product",
          aliases: [],
          tags: [],
          model: null,
          upc: null,
          notes: null,
          expectedQuantity: null,
          ingredientId: null,
          categoryId: null,
        }),
      );
      await createFixtureWithContext(
        context,
        "expense",
        expenseCreateInput.parse({
          name: "Synthetic unlinked expense",
          cost: 8,
          date: "2026-09-01",
          trade: "other",
          costType: "materials",
        }),
      );
      return;
    }
    case "images": {
      const client = await request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: baseURL },
      });
      try {
        const login = await client.post("/api/auth/sign-in/email", {
          data: { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD },
        });
        if (!login.ok())
          throw new Error(`Local image fixture auth failed: ${login.status()}`);
        const bytes = await readFile(
          new URL(
            "../../tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
            import.meta.url,
          ),
        );
        const init = await client.post("/api/v1/image/uploadImage", {
          data: {
            filename: "synthetic-fixture-shirt.png",
            contentType: "image/png",
            size: bytes.length,
          },
        });
        if (!init.ok())
          throw new Error(
            `Local image upload initiation failed: ${init.status()} ${await init.text()}`,
          );
        const upload = initiateUploadWithoutEntityResponseSchema.parse(
          await init.json(),
        );
        if (new URL(upload.uploadUrl).origin !== new URL(baseURL).origin)
          throw new Error("Local image upload escaped the local origin");
        const stored = await client.put(upload.uploadUrl, {
          data: bytes,
          headers: { "Content-Type": "image/png" },
        });
        if (!stored.ok())
          throw new Error(
            `Local image storage failed: ${stored.status()} ${await stored.text()}`,
          );
        const final = await client.post("/api/v1/image/markUploaded", {
          data: { id: upload.imageId },
        });
        if (!final.ok())
          throw new Error(
            `Local image finalization failed: ${final.status()} ${await final.text()}`,
          );
      } finally {
        await client.dispose();
      }
      return;
    }
  }
}
