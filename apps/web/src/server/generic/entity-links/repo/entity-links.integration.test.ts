/**
 * `EntityLink` (ADR 0007): the database, not the call sites, owns what a link
 * may be. Failure modes pinned here:
 *
 * - a link whose kind and endpoint kinds disagree with the declaration, or
 *   whose endpoint kind disagrees with the Entity row, is refused;
 * - a quantity on a kind that declares none, or a missing one on a counted
 *   kind, is refused;
 * - a live link to a deleted entity is refused by the trigger, while
 *   soft-deleting such a link stays possible;
 * - an acyclic kind refuses a write that would close a cycle, and a
 *   self-dependency is refused by the database;
 * - a merge repoint resolves collisions by each end's declared rule and
 *   drops the links it would turn into self-links.
 */
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb, withTransaction } from "~/server/db/helpers";
import { entityLink, product } from "~/server/db/schema";
import {
  getProjectByID,
  updateProject,
} from "~/server/domains/project/repo/crud";
import {
  getTaskByShortcode,
  updateTask,
} from "~/server/domains/task/repo/crud";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { linkValues, liveLinks, repointLinkEnd } from "./entity-links";

/** The Postgres error behind Drizzle's wrapper, for its code and constraint. */
const pgRefusal = z.object({
  cause: z.object({ code: z.string(), constraint: z.string().optional() }),
});
const pgCause = async (write: Promise<unknown>) => {
  try {
    await write;
  } catch (error) {
    return pgRefusal.parse(error).cause;
  }
  throw new Error("The write was not refused.");
};

describe("EntityLink constraints", () => {
  const ctx = withTestDb();

  const mkProduct = async (name: string) =>
    (await createProduct(ctx.db, makeProductInput({ name }), ctx.actor))
      .entityId;
  const mkWish = async (name: string) =>
    (await insertWithShortcode(ctx.db, "wish", { name })).id;

  it("refuses a link whose kind and endpoint kinds do not match the declaration", async () => {
    const [kit, part] = [await mkProduct("Kit A"), await mkProduct("Part A")];
    const insert = (values: typeof entityLink.$inferInsert) =>
      getDb(ctx.db).insert(entityLink).values(values);

    // Declared endpoint kinds, wrong link kind for them.
    await expect(
      pgCause(
        insert({
          ...linkValues("productComponent", kit, part, 1),
          kind: "wishCandidate",
        }),
      ),
    ).resolves.toMatchObject({
      code: "23514",
      constraint: "EntityLink_kind_check",
    });
    // Kinds agree with each other but not with the Entity rows they name.
    const wish = await mkWish("Wish A");
    await expect(
      pgCause(insert(linkValues("wishCandidate", kit, part))),
    ).resolves.toMatchObject({
      code: "23503",
      constraint: "EntityLink_from_fk",
    });
    // Quantity only where the kind declares one, and required there.
    await expect(
      pgCause(
        insert({ ...linkValues("wishCandidate", wish, part), quantity: 2 }),
      ),
    ).resolves.toMatchObject({
      code: "23514",
      constraint: "EntityLink_quantity_check",
    });
    await expect(
      pgCause(
        insert({
          ...linkValues("productComponent", kit, part),
          quantity: null,
        }),
      ),
    ).resolves.toMatchObject({
      code: "23514",
      constraint: "EntityLink_quantity_check",
    });
    // No self-link on kinds that forbid it.
    await expect(
      pgCause(insert(linkValues("productComponent", kit, kit, 1))),
    ).resolves.toMatchObject({
      code: "23514",
      constraint: "EntityLink_no_self_check",
    });

    await insert(linkValues("productComponent", kit, part, 3));
    await insert(linkValues("wishCandidate", wish, part));
  });

  it("refuses a live link to a deleted entity but still lets that link be soft-deleted", async () => {
    const [kit, part] = [await mkProduct("Kit B"), await mkProduct("Part B")];
    const [link] = await getDb(ctx.db)
      .insert(entityLink)
      .values(linkValues("productComponent", kit, part, 1))
      .returning({ id: entityLink.id });
    const gone = await mkProduct("Gone B");
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, gone));

    await expect(
      pgCause(
        getDb(ctx.db)
          .insert(entityLink)
          .values(linkValues("productComponent", kit, gone, 1)),
      ),
    ).resolves.toMatchObject({
      code: "23503",
      constraint: "EntityLink_live_endpoints_check",
    });

    // The endpoint of an existing link is deleted: re-touching the live row
    // is refused, retiring it is not.
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, part));
    await expect(
      pgCause(
        getDb(ctx.db)
          .update(entityLink)
          .set({ quantity: 2 })
          .where(eq(entityLink.id, link!.id)),
      ),
    ).resolves.toMatchObject({ constraint: "EntityLink_live_endpoints_check" });
    await getDb(ctx.db)
      .update(entityLink)
      .set({ deletedAt: new Date() })
      .where(eq(entityLink.id, link!.id));
  });

  /**
   * Task and project dependencies share one acyclic link path; each kind is
   * driven through its own repository update so the wiring is covered too.
   */
  const dependencyGraph = {
    task: async () => {
      const rows: Awaited<ReturnType<typeof createRepoEntity<"task">>>[] = [];
      for (const name of ["a", "b", "c"])
        rows.push(
          await createRepoEntity(ctx, "task", {
            trade: "other",
            name: `dependency task ${name}`,
          }),
        );
      const ids = (at: number[]) => at.map((index) => rows[index]!.output.id);
      return {
        linkKind: "taskDependency" as const,
        entityIds: rows.map((row) => row.entityId),
        ids,
        block: (at: number, blockedBy: number[]) =>
          updateTask(
            ctx.db,
            rows[at]!.output.id,
            { blockedByIds: ids(blockedBy) },
            ctx.actor,
          ),
        blockedBy: async (at: number) =>
          (await getTaskByShortcode(ctx.db, rows[at]!.output.id))?.blockedByIds,
      };
    },
    project: async () => {
      const rows: Awaited<ReturnType<typeof createRepoEntity<"project">>>[] =
        [];
      for (const name of ["a", "b", "c"])
        rows.push(
          await createRepoEntity(ctx, "project", {
            name: `dependency project ${name}`,
          }),
        );
      const ids = (at: number[]) => at.map((index) => rows[index]!.output.id);
      return {
        linkKind: "projectDependency" as const,
        entityIds: rows.map((row) => row.entityId),
        ids,
        block: (at: number, blockedBy: number[]) =>
          updateProject(
            ctx.db,
            rows[at]!.output.id,
            { blockedByIds: ids(blockedBy) },
            ctx.actor,
          ),
        blockedBy: async (at: number) =>
          (await getProjectByID(ctx.db, rows[at]!.entityId)).blockedByIds,
      };
    },
  };

  it.each(["task", "project"] as const)(
    "refuses a %s dependency cycle or self-link and keeps prior edges",
    async (kind) => {
      const graph = await dependencyGraph[kind]();
      await graph.block(0, [1]);
      await graph.block(1, [2]);

      await expect(graph.block(2, [0])).rejects.toMatchObject({
        reason: "DEPENDENCY_CYCLE",
      });
      // The refused write replaced nothing, on either end of the cycle.
      expect(await graph.blockedBy(0)).toEqual(graph.ids([1]));
      expect(await graph.blockedBy(2)).toEqual([]);

      // The database backstops a self-dependency the repository never writes.
      const [self] = graph.entityIds;
      await expect(
        pgCause(
          getDb(ctx.db)
            .insert(entityLink)
            .values(linkValues(graph.linkKind, self!, self!)),
        ),
      ).resolves.toMatchObject({ code: "23514" });

      // Replacing a set soft-deletes the dropped link; the pair can return.
      await graph.block(0, []);
      await graph.block(2, [0]);
      expect(await graph.blockedBy(2)).toEqual(graph.ids([0]));
      expect(await graph.blockedBy(1)).toEqual(graph.ids([2]));
      expect(await graph.blockedBy(0)).toEqual([]);
      await expect(
        getDb(ctx.db)
          .select({ id: entityLink.id })
          .from(entityLink)
          .where(liveLinks(graph.linkKind)),
      ).resolves.toHaveLength(2);
    },
  );
});

describe("repointLinkEnd", () => {
  const ctx = withTestDb();

  const mkProduct = async (name: string) =>
    (await createProduct(ctx.db, makeProductInput({ name }), ctx.actor))
      .entityId;

  const componentRows = () =>
    getDb(ctx.db)
      .select({
        from: entityLink.fromEntityId,
        to: entityLink.toEntityId,
        quantity: entityLink.quantity,
      })
      .from(entityLink)
      .where(liveLinks("productComponent"));

  it("sums the part side, dedupes equal kit rows, and drops self-links", async () => {
    const [keep, loser, kitX, partY] = [
      await mkProduct("Keep"),
      await mkProduct("Loser"),
      await mkProduct("Kit X"),
      await mkProduct("Part Y"),
    ];
    await getDb(ctx.db)
      .insert(entityLink)
      .values([
        // Part side: kit X lists both merged products.
        linkValues("productComponent", kitX, keep, 2),
        linkValues("productComponent", kitX, loser, 3),
        // Kit side: both merged kits list part Y at the same quantity.
        linkValues("productComponent", keep, partY, 1),
        linkValues("productComponent", loser, partY, 1),
        // Becomes keep -> keep after the merge.
        linkValues("productComponent", loser, keep, 1),
      ]);

    await withTransaction(ctx.db, async (tx) => {
      await expect(
        repointLinkEnd(tx, {
          kind: "productComponent",
          end: "to",
          keepId: keep,
          loserIds: [loser],
        }),
      ).resolves.toMatchObject({ summed: 1 });
      await repointLinkEnd(tx, {
        kind: "productComponent",
        end: "from",
        keepId: keep,
        loserIds: [loser],
      });
    });

    expect(await componentRows()).toEqual(
      expect.arrayContaining([
        { from: kitX, to: keep, quantity: 5 },
        { from: keep, to: partY, quantity: 1 },
      ]),
    );
    expect(await componentRows()).toHaveLength(2);
  });

  it("refuses a kit-side collision with different quantities", async () => {
    const [keep, loser, partY] = [
      await mkProduct("Keep Q"),
      await mkProduct("Loser Q"),
      await mkProduct("Part Q"),
    ];
    await getDb(ctx.db)
      .insert(entityLink)
      .values([
        linkValues("productComponent", keep, partY, 1),
        linkValues("productComponent", loser, partY, 4),
      ]);
    await expect(
      withTransaction(ctx.db, (tx) =>
        repointLinkEnd(tx, {
          kind: "productComponent",
          end: "from",
          keepId: keep,
          loserIds: [loser],
        }),
      ),
    ).rejects.toMatchObject({
      reason: "PRODUCT_MERGE_COMPONENT_QUANTITY_MISMATCH",
    });
  });

  it("drops the loser's duplicate for a dropLoser kind", async () => {
    const [keep, loser] = [
      await mkProduct("Keep W"),
      await mkProduct("Loser W"),
    ];
    const wish = (await insertWithShortcode(ctx.db, "wish", { name: "Wish W" }))
      .id;
    await getDb(ctx.db)
      .insert(entityLink)
      .values([
        linkValues("wishCandidate", wish, keep),
        linkValues("wishCandidate", wish, loser),
      ]);
    await withTransaction(ctx.db, (tx) =>
      repointLinkEnd(tx, {
        kind: "wishCandidate",
        end: "to",
        keepId: keep,
        loserIds: [loser],
      }),
    );
    const live = await getDb(ctx.db)
      .select({ to: entityLink.toEntityId })
      .from(entityLink)
      .where(
        and(liveLinks("wishCandidate"), eq(entityLink.fromEntityId, wish)),
      );
    expect(live).toEqual([{ to: keep }]);
  });
});
