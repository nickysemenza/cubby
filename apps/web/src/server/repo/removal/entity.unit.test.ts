import type { ActorContext } from "@cubby/schemas/context";
import type { BrandForEntity } from "@cubby/schemas/identifiers";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { DrizzleTransaction } from "~/server/db";
import {
  auditLog,
  entityEmbedding,
  product,
  productImage,
  productUnitMappings,
  task,
  taskDependency,
} from "~/server/db/schema";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-utils";
import type { RemovableEntity } from "./core";
import { type ChildCascade, removeEntity } from "./entity";

const ACTOR: ActorContext = { userId: unsafeUserId("user-1"), source: "ui" };

const AUDIT = getTableName(auditLog);
const EMBEDDING = getTableName(entityEmbedding);

type Statement =
  | { op: "select" | "update" | "delete"; table: string }
  | { op: "insert"; table: string; rows: Array<Record<string, unknown>> };

/**
 * A `tx` that records the statements a removal issues, in order, without a
 * database. Statement *order* is the whole point of the module — children
 * before the parent, cascade after both — and it is unobservable from the
 * outside once a real transaction commits, so a recorder is the only place it
 * can be asserted at all.
 *
 * `rollback` is present so `withTransactionOn` recognizes this as an already-
 * open transaction and joins it rather than reaching for a pool.
 */
const recordingTx = (
  counts: Record<string, Array<{ key: string; n: number }>> = {},
) => {
  const log: Statement[] = [];
  const tx = {
    rollback: () => undefined,
    select: () => ({
      from: (table: PgTable) => {
        const name = getTableName(table);
        log.push({ op: "select", table: name });
        return {
          where: () => ({ groupBy: async () => counts[name] ?? [] }),
        };
      },
    }),
    update: (table: PgTable) => ({
      set: () => {
        log.push({ op: "update", table: getTableName(table) });
        return { where: async () => undefined };
      },
    }),
    delete: (table: PgTable) => {
      log.push({ op: "delete", table: getTableName(table) });
      return { where: async () => undefined };
    },
    insert: (table: PgTable) => ({
      values: async (rows: Array<Record<string, unknown>>) => {
        log.push({ op: "insert", table: getTableName(table), rows });
      },
    }),
  };
  return { log, tx: tx as unknown as DrizzleTransaction };
};

const ids = <E extends RemovableEntity>(...v: string[]) =>
  v as BrandForEntity<E>[];

const auditRows = (log: Statement[]) =>
  log.flatMap((s) => (s.op === "insert" && s.table === AUDIT ? s.rows : []));

describe("removeEntity — statement order", () => {
  it("removes children in declared order, then the parent, then the cascade", async () => {
    const { log, tx } = recordingTx();
    await removeEntity(tx, {
      entity: "product",
      ids: ids<"product">("p1"),
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: productUnitMappings,
          parentColumn: productUnitMappings.productId,
        },
        { table: productImage, parentColumn: productImage.productId },
      ],
    });

    expect(log.map((s) => `${s.op} ${s.table}`)).toEqual([
      `update ${getTableName(productUnitMappings)}`,
      `update ${getTableName(productImage)}`,
      `update ${getTableName(product)}`,
      `update ${EMBEDDING}`,
      `insert ${AUDIT}`,
    ]);
  });

  it("counts every audited child before issuing any removal", async () => {
    // A count taken after a sibling edge had already been cleared would report
    // the wrong number, so the ordering here is behavioral, not incidental.
    const { log, tx } = recordingTx({
      [getTableName(productImage)]: [{ key: "p1", n: 2 }],
    });
    await removeEntity(tx, {
      entity: "product",
      ids: ids<"product">("p1"),
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: productUnitMappings,
          parentColumn: productUnitMappings.productId,
        },
        {
          table: productImage,
          parentColumn: productImage.productId,
          auditKey: "cascadedImages",
        },
      ],
    });

    expect(log.map((s) => s.op)).toEqual([
      "select",
      "update",
      "update",
      "update",
      "update",
      "insert",
    ]);
    expect(auditRows(log)[0]?.changes).toEqual({
      cascadedImages: { from: 2, to: 0 },
    });
  });

  it("issues no statements at all for an empty id set", async () => {
    const { log, tx } = recordingTx();
    await removeEntity(tx, {
      entity: "product",
      ids: ids<"product">(),
      removal: "soft",
      actor: ACTOR,
    });
    expect(log).toEqual([]);
  });
});

describe("removeEntity — removal mode", () => {
  it("hard-deletes the parent row instead of stamping deletedAt", async () => {
    const { log, tx } = recordingTx();
    await removeEntity(tx, {
      entity: "product",
      ids: ids<"product">("p1"),
      removal: "hard",
      actor: ACTOR,
    });
    // The embedding is still SOFT-deleted after a hard parent delete — that is
    // what lets one cascade cover both modes (see `core.ts`).
    expect(log.map((s) => `${s.op} ${s.table}`)).toEqual([
      `delete ${getTableName(product)}`,
      `update ${EMBEDDING}`,
      `insert ${AUDIT}`,
    ]);
  });

  it("hard-deletes a hard child and never counts it", async () => {
    // `countByTarget` throws on a table with no `deletedAt`; `TaskDependency`
    // is one, so the absence of a SELECT here is what keeps it from throwing.
    const { log, tx } = recordingTx();
    await removeEntity(tx, {
      entity: "task",
      ids: ids<"task">("t1"),
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: taskDependency,
          parentColumn: taskDependency.taskId,
          mode: "hard",
        },
      ],
    });
    expect(log.map((s) => `${s.op} ${s.table}`)).toEqual([
      `delete ${getTableName(taskDependency)}`,
      `update ${getTableName(task)}`,
      `update ${EMBEDDING}`,
      `insert ${AUDIT}`,
    ]);
  });
});

describe("removeEntity — the parent table is derived, not passed", () => {
  // Table-driven over the whole roster: deriving the table from `entity` is
  // what makes `{entity: "vendor"}` against the `product` table unwritable, and
  // only enumerating every entity proves the lookup is right for each one.
  it.each(Object.keys(SHORTCODE_TABLE) as RemovableEntity[])(
    "removes %s rows from its own SHORTCODE_TABLE entry",
    async (entity) => {
      const { log, tx } = recordingTx();
      await removeEntity(tx, {
        entity,
        ids: ids("x1"),
        removal: "soft",
        actor: ACTOR,
      });
      expect(log[0]).toEqual({
        op: "update",
        table: getTableName(SHORTCODE_TABLE[entity]),
      });
      expect(auditRows(log).map((row) => row.entityType)).toEqual([entity]);
    },
  );
});

describe("removeEntity — the type-level lock", () => {
  it("refuses an auditKey on a hard-delete child", () => {
    // The directive sits on the declaration because a union mismatch is
    // reported against the whole literal, not the offending property.
    // @ts-expect-error a hard-delete child cannot be counted, so it has no audit key
    const child: ChildCascade = {
      table: taskDependency,
      parentColumn: taskDependency.taskId,
      mode: "hard",
      auditKey: "cascadedDependencies",
    };
    void child;
  });

  it("refuses a soft-delete child whose table has no deletedAt", () => {
    // @ts-expect-error TaskDependency has no deletedAt, so it cannot be soft-deleted
    const child: ChildCascade = {
      table: taskDependency,
      parentColumn: taskDependency.taskId,
    };
    void child;
  });

  it("refuses ids branded for a different entity", () => {
    const { tx } = recordingTx();
    void removeEntity(tx, {
      entity: "product",
      // @ts-expect-error task ids cannot be passed as a product removal
      ids: ids<"task">("t1"),
      removal: "soft",
      actor: ACTOR,
    });
  });
});
