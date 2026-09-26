import type { ProductId, ProductShortcode } from "@cubby/schemas/identifiers";
import { projectCreateInput } from "@cubby/schemas/project";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { projectToolUsage } from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  projectRepointUsesWorkflow,
  projectSetToolUsageWorkflow,
} from "~/server/workflows/project.server";

import { taxonomyShortcode } from "../../../tooling/product-category-fixtures";
import { getDb, notDeleted } from "./database-helpers";
import { deleteProducts } from "./product";
import { createProject, deleteProjects } from "./project";
import { attachProjectResources, repointProjectUses } from "./project/tools";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "./repo.fixtures";

describe("project reusable resources", () => {
  const ctx = withTestDb();

  it("resolves workflow shortcodes and preserves usage idempotence through repoint and detach", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Workflow resource project" }),
      ctx.actor,
    );
    const source = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Source drill",
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );
    const target = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Replacement drill",
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );
    const projectId = project.output.id;
    const kernel = requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const resources = (
      action: "attach" | "detach",
      productId: ProductShortcode,
    ) =>
      executeEntity(kernel, {
        action,
        entity: "project",
        relation: "resources",
        id: projectId,
        items: [{ id: productId }],
      });
    await expect(resources("attach", source.id)).resolves.toMatchObject({
      result: { changed: 1 },
    });
    await expect(
      executeEntity(kernel, {
        action: "listRelation",
        entity: "project",
        relation: "resources",
        id: projectId,
      }),
    ).resolves.toMatchObject({ items: [{ productId: source.id }] });
    await expect(
      projectSetToolUsageWorkflow(
        ctx.db,
        { projectId, productId: source.id, used: true },
        ctx.actor,
      ),
    ).resolves.toEqual({
      projectId,
      productId: source.id,
      used: true,
      changed: false,
    });
    await expect(
      projectRepointUsesWorkflow(
        ctx.db,
        {
          fromProductId: source.id,
          toProductId: target.id,
          projectIds: [projectId],
        },
        ctx.actor,
      ),
    ).resolves.toEqual({ repointed: 1, alreadyPresent: 0 });
    const live = await getDb(ctx.db).query.projectToolUsage.findMany({
      where: and(
        eq(projectToolUsage.projectId, project.entityId),
        notDeleted(projectToolUsage),
      ),
      columns: { productId: true },
    });
    expect(live).toEqual([{ productId: target.entityId }]);
    await expect(resources("detach", target.id)).resolves.toMatchObject({
      result: { changed: 1 },
    });
    await expect(
      projectSetToolUsageWorkflow(
        ctx.db,
        { projectId, productId: target.id, used: false },
        ctx.actor,
      ),
    ).resolves.toMatchObject({ changed: false });
  });

  it("preserves use history on product delete and cascades it on project delete", async () => {
    const { output: project, entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Tool lifecycle project" }),
      ctx.actor,
    );
    const tool = await createProduct(
      ctx.db,
      makeProductInput({
        name: "History-only tool",
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );
    await attachProjectResources(ctx.db, projectId, [tool.entityId], ctx.actor);

    await expect(
      deleteProducts(ctx.db, [tool.entityId], ctx.actor),
    ).rejects.toMatchObject({
      reason: "PRODUCT_HAS_PROJECT_USES",
    });

    await deleteProjects(ctx.db, [project.id], ctx.actor);
    await expect(
      deleteProducts(ctx.db, [tool.entityId], ctx.actor),
    ).resolves.toMatchObject({ detachedImageKeys: [] });
  });

  // Tool accessories (e.g. jigs and guides) nest under Tools but keep their
  // own feature; the project-resource capability grants it too.
  it("accepts a Tool accessories Product as a project resource", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Tool accessories capability project" }),
      ctx.actor,
    );
    const candidate = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Tool accessories candidate",
        categoryId: taxonomyShortcode("tool-accessories"),
      }),
      ctx.actor,
    );
    await expect(
      attachProjectResources(
        ctx.db,
        project.entityId,
        [candidate.entityId],
        ctx.actor,
      ),
    ).resolves.toMatchObject({ changed: 1 });
  });

  // Tool consumables nest under Tools the same way, but the capability does
  // not grant it — a consumable is used up, not a reusable project resource.
  it("refuses a Tool consumables Product as a project resource", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Tool consumables capability project" }),
      ctx.actor,
    );
    const candidate = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Tool consumables candidate",
        categoryId: taxonomyShortcode("tool-consumables"),
      }),
      ctx.actor,
    );
    await expect(
      attachProjectResources(
        ctx.db,
        project.entityId,
        [candidate.entityId],
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "PRODUCT_CATEGORY_INELIGIBLE" });
  });
});

// `deleteProducts` blocks on live project uses, and before this the only way
// past it was detach — which drops the project's tool history entirely. Merge
// never had this problem (finalizeMerge derives the cascade from the entity);
// delete had no counterpart until repointProjectUses.
describe("repointProjectUses", () => {
  const ctx = withTestDb();

  const seed = async (name: string) => {
    const [kitchen, yard, shed] = await Promise.all([
      createProject(
        ctx.db,
        projectCreateInput.parse({ name: `${name} kitchen` }),
        ctx.actor,
      ),
      createProject(
        ctx.db,
        projectCreateInput.parse({ name: `${name} yard` }),
        ctx.actor,
      ),
      createProject(
        ctx.db,
        projectCreateInput.parse({ name: `${name} shed` }),
        ctx.actor,
      ),
    ]);
    const [kit, component] = await Promise.all([
      createProduct(
        ctx.db,
        makeProductInput({
          name: `${name} kit`,
          categoryId: taxonomyShortcode("tools"),
        }),
        ctx.actor,
      ),
      createProduct(
        ctx.db,
        makeProductInput({
          name: `${name} bare tool`,
          categoryId: taxonomyShortcode("tools"),
        }),
        ctx.actor,
      ),
    ]);
    return { kitchen, yard, shed, kit, component };
  };

  const liveProjectIdsFor = async (productEntityId: ProductId) => {
    const rows = await getDb(ctx.db).query.projectToolUsage.findMany({
      where: and(
        eq(projectToolUsage.productId, productEntityId),
        notDeleted(projectToolUsage),
      ),
      columns: { projectId: true },
    });
    return rows.map((row) => row.projectId).sort();
  };

  it("moves every live use and unblocks the source's delete", async () => {
    const { kitchen, yard, kit, component } = await seed("Repoint");
    await attachProjectResources(
      ctx.db,
      kitchen.entityId,
      [kit.entityId],
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      yard.entityId,
      [kit.entityId],
      ctx.actor,
    );

    const result = await repointProjectUses(
      ctx.db,
      { fromProductId: kit.entityId, toProductId: component.entityId },
      ctx.actor,
    );

    expect(result).toEqual({ repointed: 2, alreadyPresent: 0 });
    expect(await liveProjectIdsFor(kit.entityId)).toEqual([]);
    expect(await liveProjectIdsFor(component.entityId)).toEqual(
      [kitchen.entityId, yard.entityId].sort(),
    );
    await expect(
      deleteProducts(ctx.db, [kit.entityId], ctx.actor),
    ).resolves.toMatchObject({ detachedImageKeys: [] });
  });

  it("keeps one live row when the destination already records the project", async () => {
    // The partial unique index `(projectId, productId)` makes a bare
    // `UPDATE ... SET productId` abort the transaction here. foldAssociation
    // drops the colliding source row instead, so the history is intact.
    const { kitchen, kit, component } = await seed("Collide");
    await attachProjectResources(
      ctx.db,
      kitchen.entityId,
      [kit.entityId, component.entityId],
      ctx.actor,
    );

    const result = await repointProjectUses(
      ctx.db,
      { fromProductId: kit.entityId, toProductId: component.entityId },
      ctx.actor,
    );

    expect(result).toEqual({ repointed: 0, alreadyPresent: 1 });
    expect(await liveProjectIdsFor(component.entityId)).toEqual([
      kitchen.entityId,
    ]);
    expect(await liveProjectIdsFor(kit.entityId)).toEqual([]);
  });

  it("refuses a destination that is not a tool or software", async () => {
    const { kitchen, kit } = await seed("Category");
    const consumable = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Category screws",
        categoryId: taxonomyShortcode("hardware"),
      }),
      ctx.actor,
    );
    await attachProjectResources(
      ctx.db,
      kitchen.entityId,
      [kit.entityId],
      ctx.actor,
    );

    await expect(
      repointProjectUses(
        ctx.db,
        { fromProductId: kit.entityId, toProductId: consumable.entityId },
        ctx.actor,
      ),
      // NOT `PRODUCT_NOT_FOUND` — the destination exists and is live, it is
      // simply the wrong category, and the two used to be indistinguishable.
      // The refusal also NAMES the offending shortcode, structurally.
    ).rejects.toMatchObject({
      reason: "PRODUCT_CATEGORY_INELIGIBLE",
    });
    const refusalSchema = z.object({
      blockers: z
        .array(z.object({ byTargetId: z.record(z.string(), z.number()) }))
        .optional(),
    });
    const captureRefusal = async () => {
      try {
        await repointProjectUses(
          ctx.db,
          { fromProductId: kit.entityId, toProductId: consumable.entityId },
          ctx.actor,
        );
      } catch (error) {
        return refusalSchema.parse(error);
      }
      throw new Error("Expected project tool repoint to be refused");
    };
    const refusal = await captureRefusal();
    expect(
      refusal.blockers?.flatMap((blocker) => Object.keys(blocker.byTargetId)),
    ).toEqual([consumable.id]);
  });
});
