import type { ProjectId } from "@cubby/schemas/identifiers";
import { ingredientCreateInput } from "@cubby/schemas/ingredient";
import { projectCreateInput } from "@cubby/schemas/project";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { parseShortcode } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, expectTypeOf, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { createTestCaller } from "~/server/api/trpc";
import { listBackgroundBatches } from "~/server/repo/background-jobs";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { ingredientRouter } from "./ingredient";
import { locationRouter } from "./location";
import { productRouter } from "./product";
import { projectRouter } from "./project";
import { vendorRouter } from "./vendor";

describe("searchable CRUD factory", () => {
  const ctx = withTestDb();

  it("preserves branded IDs and runs create/update embedding side effects", async () => {
    const caller = createTestCaller(projectRouter, ctx.db);
    const created = await caller.create(
      mock(projectCreateInput, {
        overrides: { name: "Searchable CRUD project" },
      }),
    );
    expectTypeOf(created.id).toEqualTypeOf<ProjectId>();

    const updated = await caller.update({
      id: created.id,
      data: { name: "Updated searchable CRUD project" },
    });
    expect(updated.id).toBe(created.id);

    const batches = await listBackgroundBatches(ctx.db, 20);
    expect(
      batches.filter((batch) => batch.kind === "entity-embedding.refresh"),
    ).toHaveLength(2);
  });
});

/**
 * The shortcode cutover's ground truth: every entity that crosses the MCP
 * boundary must mint a real, well-formed, correctly-prefixed shortcode on
 * create — independent of whatever the MCP output-projection layer
 * (`apps/web/src/server/mcp/tools/**`, mid-flight as of this writing) does
 * with that value. This exercises the router layer directly (uuid ids, same
 * as every other router test in this file) so a regression here can only be
 * "the repo stopped minting a shortcode," never "the MCP slim projection
 * hasn't been updated yet."
 */
describe("every entity router stamps a usable, correctly-prefixed shortcode on create", () => {
  const ctx = withTestDb();

  it("product", async () => {
    const caller = createTestCaller(productRouter, ctx.db);
    const created = await caller.create(
      makeProductInput({ name: "Shortcode Ground Truth Product" }),
    );
    expect(parseShortcode(created.shortcode)).toMatchObject({
      type: "product",
      legacy: false,
    });
  });

  it("location", async () => {
    const caller = createTestCaller(locationRouter, ctx.db);
    const created = await caller.create(
      makeLocationInput({ name: "Shortcode Ground Truth Location" }),
    );
    expect(parseShortcode(created.shortcode)).toMatchObject({
      type: "location",
      legacy: false,
    });
  });

  it("ingredient", async () => {
    const caller = createTestCaller(ingredientRouter, ctx.db);
    const created = await caller.create(
      mock(ingredientCreateInput, {
        overrides: { name: "Shortcode Ground Truth Ingredient" },
      }),
    );
    expect(parseShortcode(created.shortcode)).toMatchObject({
      type: "ingredient",
      legacy: false,
    });
  });

  it("vendor", async () => {
    const caller = createTestCaller(vendorRouter, ctx.db);
    const created = await caller.create(
      mock(vendorCreateInput, {
        overrides: { name: "Shortcode Ground Truth Vendor" },
      }),
    );
    expect(parseShortcode(created.shortcode)).toMatchObject({
      type: "vendor",
      legacy: false,
    });
  });
});
