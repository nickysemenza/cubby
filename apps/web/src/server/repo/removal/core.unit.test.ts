import type { ActorContext } from "@cubby/schemas/context";
import type { AuditableEntity } from "@cubby/schemas/entity-manifest";
import { auditableEntities } from "@cubby/schemas/entity-manifest";
import { type BrandForEntity, unsafeUserId } from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { DrizzleTransaction } from "~/server/db";
import type { AuditEntryInput } from "~/server/repo/audit-log";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-utils";
import { cascadeRemoval, type RemovableEntity } from "./core";

const ACTOR: ActorContext = { userId: unsafeUserId("user-1"), source: "ui" };

/**
 * A `tx` that records the shape of what a removal issues, without a database.
 * `update(table).set(v).where(c)` is the only chain `cascadeRemoval` drives
 * directly; the audit insert goes through `logAuditEntries`, so a `values()`
 * call is recorded too.
 */
type Recorded = {
  updates: Array<{ table: unknown; values: Record<string, unknown> }>;
  inserted: Array<Record<string, unknown>>;
};

const recordingTx = () => {
  const log: Recorded = { updates: [], inserted: [] };
  const tx = {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          log.updates.push({ table, values });
          return { where: async () => undefined };
        },
      };
    },
    insert() {
      return {
        values: async (rows: Array<Record<string, unknown>>) => {
          log.inserted.push(...rows);
        },
      };
    },
  };
  return { log, tx: tx as unknown as DrizzleTransaction };
};

const ids = <E extends RemovableEntity>(...v: string[]) =>
  v as BrandForEntity<E>[];

describe("cascadeRemoval — the embedding cascade is derived, not passed", () => {
  // Table-driven over the whole searchable roster: the point of deriving the
  // cascade from `entity` is that adding a searchable entity cannot leave a
  // removal path silently uncovered, and only enumerating the roster proves it.
  it.each(searchableEntities)(
    "issues the embedding UPDATE for %s",
    async (entity) => {
      const { log, tx } = recordingTx();
      await cascadeRemoval(tx, {
        entity: entity as RemovableEntity,
        ids: ids("id-1", "id-2"),
        audit: { actor: ACTOR },
      });
      expect(log.updates).toHaveLength(2);
      expect(log.updates.every((update) => "deletedAt" in update.values)).toBe(
        true,
      );
      expect(log.inserted.map((row) => row.entityId)).toEqual(["id-1", "id-2"]);
      expect(log.inserted.every((row) => row.action === "delete")).toBe(true);
      expect(log.inserted.every((row) => row.entityType === entity)).toBe(true);
    },
  );

  // The negative half of the same derivation. Every `RemovableEntity` happens
  // to be searchable today, so the only way to exercise the `isSearchable`
  // gate's false branch is a synthetic entity — without this, an unconditional
  // cascade would pass the table above just as well.
  it("skips the embedding UPDATE for an auditable-but-not-searchable entity", async () => {
    const { log, tx } = recordingTx();
    await cascadeRemoval(tx, {
      entity: "notSearchable" as unknown as RemovableEntity,
      ids: ids("id-1"),
      audit: { actor: ACTOR },
    });
    expect(log.updates).toEqual([]);
    // The audit entry is still written: a non-searchable entity's removal is
    // still a removal.
    expect(log.inserted).toHaveLength(1);
  });

  it("does nothing at all for an empty id set", async () => {
    const { log, tx } = recordingTx();
    await cascadeRemoval(tx, {
      entity: "product",
      ids: ids(),
      audit: { actor: ACTOR },
    });
    expect(log).toEqual({ updates: [], inserted: [] });
  });

  it("renders cascade counts as a from→0 diff, omitting zero counts", async () => {
    const { log, tx } = recordingTx();
    await cascadeRemoval(tx, {
      entity: "product",
      ids: ids("p1", "p2"),
      audit: { actor: ACTOR },
      counts: { cascadedImages: { p1: 3, p2: 0 } },
    });
    expect(log.inserted[0]?.changes).toEqual({
      cascadedImages: { from: 3, to: 0 },
    });
    expect(log.inserted[1]?.changes).toBeUndefined();
  });

  it("appends to the buffer instead of inserting on the {into} arm", async () => {
    const { log, tx } = recordingTx();
    const buffer: AuditEntryInput[] = [
      { entityType: "inventory", entityId: "keeper", action: "update" },
    ];
    await cascadeRemoval(tx, {
      entity: "inventory",
      ids: ids("gone"),
      audit: { into: buffer },
    });
    expect(log.inserted).toEqual([]);
    expect(log.updates).toHaveLength(2);
    expect(buffer.map((entry) => entry.action)).toEqual(["update", "delete"]);
  });
});

describe("cascadeRemoval — the type-level lock", () => {
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

  it("refuses ids branded for a different entity", () => {
    const { tx } = recordingTx();
    void cascadeRemoval(tx, {
      entity: "inventory",
      // @ts-expect-error product ids cannot be passed as an inventory removal
      ids: ids<"product">("prd-1"),
      audit: { actor: ACTOR },
    });
  });

  it("keeps every searchable entity removable", () => {
    // If someone marks an entity `searchable` without `auditable`/a shortcode,
    // `cascadeRemoval` could not cascade it and this stops compiling.
    expectTypeOf<SearchableEntity>().toExtend<RemovableEntity>();
  });

  it("keeps RemovableEntity aligned with the shortcode table roster", () => {
    expectTypeOf<RemovableEntity>().toEqualTypeOf<
      keyof typeof SHORTCODE_TABLE
    >();
    expect([...auditableEntities].sort()).toEqual(
      Object.keys(SHORTCODE_TABLE).sort(),
    );
    expectTypeOf<RemovableEntity>().toExtend<AuditableEntity>();
  });
});
