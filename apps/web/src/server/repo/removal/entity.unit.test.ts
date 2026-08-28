import type { ActorContext } from "@cubby/schemas/context";
import { testEntityId, testUserId } from "@cubby/schemas/testing";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { DrizzleTransaction } from "~/server/db";
import {
  auditLog,
  entityEmbedding,
  product,
  productImage,
  productUnitMappings,
  searchDocument,
  suggestionDismissal,
  task,
  taskDependency,
} from "~/server/db/schema";
// `ChildCascade` deliberately through the barrel, not `./entity`: the
// type-level tests below are assertions about the module's public surface, so
// they have to be written against the path callers actually use.
import type { ChildCascade } from "~/server/repo/removal";
import { SHORTCODE_TABLE } from "~/server/repo/shortcode-utils";

import type { RemovableEntity } from "./core";
import { removeEntity } from "./entity";

const ACTOR: ActorContext = { userId: testUserId("user-1"), source: "ui" };

const AUDIT = getTableName(auditLog);
const EMBEDDING = getTableName(entityEmbedding);
const SEARCH_DOCUMENT = getTableName(searchDocument);
const SUGGESTION_DISMISSAL = getTableName(suggestionDismissal);

type WriteStatement = {
  op: "select" | "update" | "delete";
  table: string;
  where?: SQL;
};
type Statement =
  | WriteStatement
  | { op: "insert"; table: string; rows: Array<Record<string, unknown>> };

/** The predicate a recorded statement ran with, rendered as parameterized SQL. */
const renderedWhere = (statement: Statement | undefined) => {
  if (
    statement === undefined ||
    statement.op === "insert" ||
    !statement.where
  ) {
    throw new Error("no recorded where clause");
  }
  return new PgDialect().sqlToQuery(statement.where);
};

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
          // Two shapes off one `where`: `countByTarget` grouped-counts it, and
          // the image-id read (`collectCascadingImageIds`) awaits it directly.
          // A real Promise carrying the extra method, rather than a hand-rolled
          // thenable, so both work without tripping noThenProperty.
          //
          // Resolving to no rows keeps the reap a no-op here — that it deletes
          // the right files is a real-DB question, asserted in
          // repo/image.integration.test.ts. This file only pins ORDER.
          where: () =>
            Object.assign(Promise.resolve([] as unknown[]), {
              groupBy: async () => counts[name] ?? [],
            }),
        };
      },
    }),
    update: (table: PgTable) => ({
      set: () => {
        const statement: WriteStatement = {
          op: "update",
          table: getTableName(table),
        };
        log.push(statement);
        return {
          where: async (where: SQL) => {
            statement.where = where;
          },
        };
      },
    }),
    delete: (table: PgTable) => {
      const statement: WriteStatement = {
        op: "delete",
        table: getTableName(table),
      };
      log.push(statement);
      return {
        where: async (where: SQL) => {
          statement.where = where;
        },
      };
    },
    insert: (table: PgTable) => ({
      values: async (rows: Array<Record<string, unknown>>) => {
        log.push({ op: "insert", table: getTableName(table), rows });
      },
    }),
  };
  return { log, tx: tx as unknown as DrizzleTransaction };
};

const ids = <E extends RemovableEntity>(entity: E, ...v: string[]) =>
  v.map((seed) => testEntityId(entity, seed));

const auditRows = (log: Statement[]) =>
  log.flatMap((s) => (s.op === "insert" && s.table === AUDIT ? s.rows : []));

describe("removeEntity — statement order", () => {
  it("removes children in declared order, then the parent, then the cascade", async () => {
    const { log, tx } = recordingTx();
    await removeEntity(tx, {
      entity: "product",
      ids: ids("product", "p1"),
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: productUnitMappings,
          parentColumns: [productUnitMappings.productId],
        },
        { table: productImage, parentColumns: [productImage.productId] },
      ],
    });

    expect(log.map((s) => `${s.op} ${s.table}`)).toEqual([
      // The image-join child is READ before anything is removed: the cascade
      // soft-deletes the join row, and a tombstoned row stops counting as a
      // reference, so the ids would be unfindable afterwards.
      `select ${getTableName(productImage)}`,
      `update ${getTableName(productUnitMappings)}`,
      `update ${getTableName(productImage)}`,
      `update ${getTableName(product)}`,
      `update ${EMBEDDING}`,
      `update ${SEARCH_DOCUMENT}`,
      `update ${SUGGESTION_DISMISSAL}`,
      `insert ${AUDIT}`,
    ]);
  });

  it("counts every audited child before issuing any removal", async () => {
    // A count taken after a sibling edge had already been cleared would report
    // the wrong number, so the ordering here is behavioral, not incidental.
    const productId = ids("product", "p1")[0]!;
    const { log, tx } = recordingTx({
      [getTableName(productImage)]: [{ key: productId, n: 2 }],
    });
    await removeEntity(tx, {
      entity: "product",
      ids: [productId],
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: productUnitMappings,
          parentColumns: [productUnitMappings.productId],
        },
        {
          table: productImage,
          parentColumns: [productImage.productId],
          auditKey: "cascadedImages",
        },
      ],
    });

    expect(log.map((s) => s.op)).toEqual([
      // count(productImage), then the image-id read, then the removals.
      "select",
      "select",
      "update",
      "update",
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

  it("interleaves counted and uncounted children in declared order", async () => {
    // The real multi-child shape (`deleteProjects`: two counted soft edges plus
    // an uncounted hard one). Order is declared, not sorted by mode, and the
    // hard edge contributes no SELECT and no `changes` key.
    const productId = ids("product", "p1")[0]!;
    const { log, tx } = recordingTx({
      [getTableName(productImage)]: [{ key: productId, n: 2 }],
      [getTableName(productUnitMappings)]: [{ key: productId, n: 5 }],
    });
    await removeEntity(tx, {
      entity: "product",
      ids: [productId],
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: productImage,
          parentColumns: [productImage.productId],
          auditKey: "cascadedImages",
        },
        {
          table: taskDependency,
          parentColumns: [taskDependency.taskId],
          mode: "hard",
        },
        {
          table: productUnitMappings,
          parentColumns: [productUnitMappings.productId],
          auditKey: "cascadedUnitMappings",
        },
      ],
    });

    expect(log.map((s) => `${s.op} ${s.table}`)).toEqual([
      // Both audited counts, then the image-id read, then the removals.
      `select ${getTableName(productImage)}`,
      `select ${getTableName(productUnitMappings)}`,
      `select ${getTableName(productImage)}`,
      `update ${getTableName(productImage)}`,
      `delete ${getTableName(taskDependency)}`,
      `update ${getTableName(productUnitMappings)}`,
      `update ${getTableName(product)}`,
      `update ${EMBEDDING}`,
      `update ${SEARCH_DOCUMENT}`,
      `update ${SUGGESTION_DISMISSAL}`,
      `insert ${AUDIT}`,
    ]);
    expect(auditRows(log)[0]?.changes).toEqual({
      cascadedImages: { from: 2, to: 0 },
      cascadedUnitMappings: { from: 5, to: 0 },
    });
  });

  it("issues no statements at all for an empty id set", async () => {
    const { log, tx } = recordingTx();
    await removeEntity(tx, {
      entity: "product",
      ids: ids("product"),
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
      ids: ids("product", "p1"),
      removal: "hard",
      actor: ACTOR,
    });
    // Search artifacts are still SOFT-deleted after a hard parent delete —
    // that is what lets one cascade cover both modes (see `core.ts`).
    expect(log.map((s) => `${s.op} ${s.table}`)).toEqual([
      `delete ${getTableName(product)}`,
      `update ${EMBEDDING}`,
      `update ${SEARCH_DOCUMENT}`,
      `update ${SUGGESTION_DISMISSAL}`,
      `insert ${AUDIT}`,
    ]);
  });

  it("hard-deletes a hard child and never counts it", async () => {
    // `countByTarget` throws on a table with no `deletedAt`; `TaskDependency`
    // is one, so the absence of a SELECT here is what keeps it from throwing.
    const { log, tx } = recordingTx();
    await removeEntity(tx, {
      entity: "task",
      ids: ids("task", "t1"),
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: taskDependency,
          parentColumns: [taskDependency.taskId],
          mode: "hard",
        },
      ],
    });
    expect(log.map((s) => `${s.op} ${s.table}`)).toEqual([
      `delete ${getTableName(taskDependency)}`,
      `update ${getTableName(task)}`,
      `update ${EMBEDDING}`,
      `update ${SEARCH_DOCUMENT}`,
      `update ${SUGGESTION_DISMISSAL}`,
      `insert ${AUDIT}`,
    ]);
  });
});

describe("removeEntity — multi-column child edges", () => {
  it("ORs every declared column against the same id set", async () => {
    // A dependency edge names the parent from either end, and both ends die
    // with it. Testing the rendered predicate (not just that a DELETE ran) is
    // the point: an edge that dropped one column would still look correct in
    // the statement log while leaving half the rows behind.
    const { log, tx } = recordingTx();
    const taskIds = ids("task", "t1", "t2");
    await removeEntity(tx, {
      entity: "task",
      ids: taskIds,
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: taskDependency,
          parentColumns: [
            taskDependency.taskId,
            taskDependency.blockedByTaskId,
          ],
          mode: "hard",
        },
      ],
    });

    const { sql, params } = renderedWhere(log[0]);
    expect(sql).toBe(
      `("${getTableName(taskDependency)}"."taskId" in ($1, $2) or "${getTableName(taskDependency)}"."blockedByTaskId" in ($3, $4))`,
    );
    expect(params).toEqual([...taskIds, ...taskIds]);
  });

  it("leaves a single-column edge as a bare IN, with no OR wrapper", async () => {
    const { log, tx } = recordingTx();
    const taskIds = ids("task", "t1");
    await removeEntity(tx, {
      entity: "task",
      ids: taskIds,
      removal: "soft",
      actor: ACTOR,
      children: [
        {
          table: taskDependency,
          parentColumns: [taskDependency.taskId],
          mode: "hard",
        },
      ],
    });

    // Asserted by SHAPE, not by Drizzle's exact rendered string: the property
    // is "one column means no OR wrapper", and pinning the literal SQL made
    // this test fail on formatting churn that changes nothing.
    const { sql, params } = renderedWhere(log[0]);
    expect(params).toEqual(taskIds);
    expect(sql).toContain(`"${getTableName(taskDependency)}"."taskId"`);
    expect(sql).not.toMatch(/\bor\b/i);
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
      const entityIds = ids(entity, "x1");
      await removeEntity(tx, {
        entity,
        ids: entityIds,
        removal: "soft",
        actor: ACTOR,
      });
      expect(log[0]).toMatchObject({
        op: "update",
        table: getTableName(SHORTCODE_TABLE[entity]),
      });
      expect(auditRows(log).map((row) => row.entityType)).toEqual([entity]);
    },
  );
});

describe("removeEntity — the type-level lock", () => {
  // oxlint-disable-next-line vitest/expect-expect -- This is a compile-time @ts-expect-error contract.
  it("refuses an auditKey on a hard-delete child", () => {
    // The directive sits on the declaration because a union mismatch is
    // reported against the whole literal, not the offending property.
    // @ts-expect-error a hard-delete child cannot be counted, so it has no audit key
    const child: ChildCascade = {
      table: taskDependency,
      parentColumns: [taskDependency.taskId],
      mode: "hard",
      auditKey: "cascadedDependencies",
    };
    void child;
  });

  // oxlint-disable-next-line vitest/expect-expect -- This is a compile-time @ts-expect-error contract.
  it("refuses a soft-delete child whose table has no deletedAt", () => {
    // @ts-expect-error TaskDependency has no deletedAt, so it cannot be soft-deleted
    const child: ChildCascade = {
      table: taskDependency,
      parentColumns: [taskDependency.taskId],
    };
    void child;
  });

  // oxlint-disable-next-line vitest/expect-expect -- This is a compile-time @ts-expect-error contract.
  it("refuses ids branded for a different entity", () => {
    const { tx } = recordingTx();
    void removeEntity(tx, {
      entity: "product",
      // @ts-expect-error task ids cannot be passed as a product removal
      ids: ids("task", "t1"),
      removal: "soft",
      actor: ACTOR,
    });
  });
});
