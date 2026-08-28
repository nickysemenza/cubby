import type { ActorContext } from "@cubby/schemas/context";
import type { AuditableEntity } from "@cubby/schemas/entity-manifest";
import { auditableEntities } from "@cubby/schemas/entity-manifest";
import type { SearchableEntity } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { testEntityId, testUserId } from "@cubby/schemas/testing";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, describe, expect, expectTypeOf, it } from "vitest";

import type { DrizzleTransaction } from "~/server/db";
import {
  auditLog,
  entityEmbedding,
  searchDocument,
  suggestionDismissal,
} from "~/server/db/schema";
import * as schema from "~/server/db/schema";
import type { AuditEntryInput } from "~/server/repo/audit-log";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-utils";

import { cascadeRemoval, type RemovableEntity } from "./core";

const ACTOR: ActorContext = { userId: testUserId("user-1"), source: "ui" };

/**
 * A real typed transaction adapter that records the shape of what a removal
 * issues while intercepting the SQL builders. `update(table).set(v).where(c)`
 * is the only chain `cascadeRemoval` drives directly; the audit insert goes
 * through `logAuditEntries`, so a `values()` call is recorded too.
 */
type RemovalTable =
  | typeof entityEmbedding
  | typeof searchDocument
  | typeof suggestionDismissal;
type RemovalUpdateValues = { deletedAt: Date };
type RecordedAuditRow = Pick<
  typeof auditLog.$inferInsert,
  "entityType" | "entityId" | "action" | "changes" | "userId" | "source"
>;
type Recorded = {
  updates: Array<{ table: RemovalTable; values: RemovalUpdateValues }>;
  inserted: RecordedAuditRow[];
};

const pglite = new PGlite();
const recordingDatabase = drizzle(pglite, { schema });

const recordingTx = async (
  operation: (tx: DrizzleTransaction) => Promise<void>,
) => {
  const log: Recorded = { updates: [], inserted: [] };
  await recordingDatabase.transaction(async (realTx) => {
    const tx = new Proxy(realTx, {
      get(target, property) {
        if (property === "update") {
          return (table: RemovalTable) => {
            const builder = target.update(table);
            return new Proxy(builder, {
              get(builderTarget, builderProperty) {
                if (builderProperty === "set") {
                  return (values: RemovalUpdateValues) => {
                    log.updates.push({ table, values });
                    const setBuilder = builderTarget.set(values);
                    return new Proxy(setBuilder, {
                      get(_setTarget, setProperty) {
                        if (setProperty === "where") {
                          return () => Promise.resolve();
                        }
                        throw new Error(
                          `Unexpected update builder property: ${String(setProperty)}`,
                        );
                      },
                    });
                  };
                }
                throw new Error(
                  `Unexpected update property: ${String(builderProperty)}`,
                );
              },
            });
          };
        }
        if (property === "insert") {
          return (table: typeof auditLog) => {
            const builder = target.insert(table);
            return new Proxy(builder, {
              get(_builderTarget, builderProperty) {
                if (builderProperty === "values") {
                  return (rows: RecordedAuditRow[]) => {
                    log.inserted.push(...rows);
                    return Promise.resolve();
                  };
                }
                throw new Error(
                  `Unexpected insert property: ${String(builderProperty)}`,
                );
              },
            });
          };
        }
        throw new Error(`Unexpected transaction property: ${String(property)}`);
      },
    });
    await operation(tx);
  });
  return { log };
};

afterAll(async () => {
  await pglite.close();
});

const ids = <E extends RemovableEntity>(entity: E, ...v: string[]) =>
  v.map((seed) => testEntityId(entity, seed));

describe("cascadeRemoval — derived search and suggestion cleanup", () => {
  // Table-driven over the whole searchable roster: the point of deriving the
  // cascade from `entity` is that adding a searchable entity cannot leave a
  // removal path silently uncovered, and only enumerating the roster proves it.
  it.each(searchableEntities)(
    "issues the embedding UPDATE for %s",
    async (entity) => {
      const entityIds = ids(entity, "id-1", "id-2");
      const { log } = await recordingTx(async (tx) => {
        await cascadeRemoval(tx, {
          entity,
          ids: entityIds,
          audit: { actor: ACTOR },
        });
      });
      // SearchDocument, EntityEmbedding, and source-scoped suggestion
      // dismissals all become invalid when the source entity is removed.
      expect(log.updates).toHaveLength(3);
      expect(log.updates.every((update) => "deletedAt" in update.values)).toBe(
        true,
      );
      expect(log.inserted.map((row) => row.entityId)).toEqual(entityIds);
      expect(log.inserted.every((row) => row.action === "delete")).toBe(true);
      expect(log.inserted.every((row) => row.entityType === entity)).toBe(true);
    },
  );

  // The negative half of the same derivation. Every `RemovableEntity` happens
  // to be searchable today, so the only way to exercise the `isSearchable`
  // gate's false branch is a synthetic entity — without this, an unconditional
  // cascade would pass the table above just as well.
  it("skips the embedding UPDATE for an auditable-but-not-searchable entity", async () => {
    const { log } = await recordingTx(async (tx) => {
      await cascadeRemoval(tx, {
        // @ts-expect-error synthetic entity exercises the non-searchable branch
        entity: "notSearchable",
        ids: ids("product", "id-1"),
        audit: { actor: ACTOR },
      });
    });
    expect(log.updates).toEqual([]);
    // The audit entry is still written: a non-searchable entity's removal is
    // still a removal.
    expect(log.inserted).toHaveLength(1);
  });

  it("does nothing at all for an empty id set", async () => {
    const { log } = await recordingTx(async (tx) => {
      await cascadeRemoval(tx, {
        entity: "product",
        ids: ids("product"),
        audit: { actor: ACTOR },
      });
    });
    expect(log).toEqual({ updates: [], inserted: [] });
  });

  it("renders cascade counts as a from→0 diff, omitting zero counts", async () => {
    const productIds = ids("product", "p1", "p2");
    const [firstProductId, secondProductId] = productIds;
    if (!firstProductId || !secondProductId) {
      throw new Error("Expected two product ids");
    }
    const { log } = await recordingTx(async (tx) => {
      await cascadeRemoval(tx, {
        entity: "product",
        ids: productIds,
        audit: { actor: ACTOR },
        counts: {
          cascadedImages: {
            [firstProductId]: 3,
            [secondProductId]: 0,
          },
        },
      });
    });
    expect(log.inserted[0]?.changes).toEqual({
      cascadedImages: { from: 3, to: 0 },
    });
    expect(log.inserted[1]?.changes).toBeUndefined();
  });

  it("appends to the buffer instead of inserting on the {into} arm", async () => {
    const buffer: AuditEntryInput[] = [
      { entityType: "inventory", entityId: "keeper", action: "update" },
    ];
    const { log } = await recordingTx(async (tx) => {
      await cascadeRemoval(tx, {
        entity: "inventory",
        ids: ids("inventory", "gone"),
        audit: { into: buffer },
      });
    });
    expect(log.inserted).toEqual([]);
    expect(log.updates).toHaveLength(3);
    expect(buffer.map((entry) => entry.action)).toEqual(["update", "delete"]);
  });
});

describe("cascadeRemoval — the type-level lock", () => {
  // oxlint-disable-next-line vitest/expect-expect -- This is a compile-time @ts-expect-error contract.
  it("refuses a hand-written delete entry", () => {
    // The mechanism this whole module exists for. Without the phantom witness
    // on `RemovalAuditEntry` this line compiles, and the invariant goes back to
    // being a convention a runtime detector catches after the fact.
    // @ts-expect-error a delete entry can only be minted by `cascadeRemoval`
    const forged: AuditEntryInput = {
      entityType: "product",
      entityId: "p1",
      action: "delete",
    };
    void forged;
  });

  // oxlint-disable-next-line vitest/expect-expect -- This is a compile-time @ts-expect-error contract.
  it("refuses ids branded for a different entity", () => {
    void ((tx: DrizzleTransaction) => {
      void cascadeRemoval(tx, {
        entity: "inventory",
        // @ts-expect-error product ids cannot be passed as an inventory removal
        ids: ids("product", "prd-1"),
        audit: { actor: ACTOR },
      });
    });
  });

  it("keeps every searchable entity removable", () => {
    // If someone marks an entity `searchable` without `auditable`/a shortcode,
    // `cascadeRemoval` could not cascade it and this stops compiling.
    expectTypeOf<SearchableEntity>().toExtend<RemovableEntity>();
  });

  it("keeps RemovableEntity aligned with the shortcode table roster", () => {
    // `RemovableEntity` is `AuditableEntity & ShortcodeEntity`, and those two
    // sets used to coincide — every shortcoded entity was auditable, so the
    // intersection equalled the whole shortcode roster.
    //
    // `image` broke the coincidence: it was given `IMG-` so it stops being a
    // raw-uuid carve-out in every shape that can name an entity, but it stays
    // NON-auditable (it is the one hard delete, with no tombstone to annotate).
    // So it is in `SHORTCODE_TABLE` and out of `RemovableEntity` — which is the
    // correct outcome, because `removeEntity` must not be called for it;
    // `IMAGE_HARD_DELETE` owns that path.
    expectTypeOf<RemovableEntity>().toExtend<keyof typeof SHORTCODE_TABLE>();
    expect([...auditableEntities].sort()).toEqual(
      Object.keys(SHORTCODE_TABLE)
        .filter((entity) => entity !== "image")
        .sort(),
    );
    expectTypeOf<RemovableEntity>().toExtend<AuditableEntity>();
  });
});
