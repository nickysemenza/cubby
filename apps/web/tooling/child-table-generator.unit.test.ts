import { describe, expect, it } from "vitest";

import { compileChildTables } from "../../../scripts/generator/entities/child-tables";
import { validateRetainedTableBoundary } from "../../../scripts/generator/entities/child-table-boundary";
import { renderChildTables } from "../../../scripts/generator/entities/render/children";

const children = [
  {
    name: "SyntheticChild",
    exportName: "syntheticChild",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "parentId",
        kind: "uuid",
        notNull: true,
        reference: { table: "parent", column: "id", onDelete: "cascade" },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
      {
        key: "labels",
        kind: "text",
        array: true,
        default: { sql: "'{}'::text[]" },
      },
    ],
    indexes: [
      {
        name: "SyntheticChild_parent_live_key",
        unique: true,
        on: ["parentId"],
        where: "{parentId} IS NOT NULL",
      },
    ],
    checks: [
      {
        name: "SyntheticChild_labels_check",
        sql: "cardinality({labels}) >= 0",
      },
    ],
  },
] as const;

describe("child table generation", () => {
  it("blocks a new handwritten table while permitting removal from the infrastructure baseline", () => {
    expect(() =>
      validateRetainedTableBoundary(
        'export const retained = pgTable("Retained", {});',
        new Set(["retained", "removed"]),
      ),
    ).not.toThrow();
    expect(() =>
      validateRetainedTableBoundary(
        'export const newcomer = pgTable("Newcomer", {});',
        new Set(["retained"]),
      ),
    ).toThrow("newcomer");
  });
  it("preserves cascade, SQL defaults, update callbacks and partial constraints without entity identity", () => {
    const tables = compileChildTables(children, new Set(["parent"]));
    const source = renderChildTables(tables);
    expect(source).toContain(
      '.references((): AnyPgColumn => parent.id, {"onDelete":"cascade"})',
    );
    expect(source).toContain(".default(sql`gen_random_uuid()`)");
    expect(source).toContain(".$onUpdate(() => new Date())");
    expect(source).toContain(".where(sql`${table.parentId} IS NOT NULL`)");
    expect(source).not.toContain("entityIdentityFk");
    expect(source).not.toContain("shortcode");
    expect(source).not.toContain("SyntheticChild_parentId_idx");
  });

  it("rejects misspelled SQL columns and unresolvable child references before emitting DDL", () => {
    expect(() =>
      compileChildTables(
        [{ ...children[0], checks: [{ name: "bad", sql: "{missing} > 0" }] }],
        new Set(["parent"]),
      ),
    ).toThrow("missing");
    expect(() => compileChildTables(children, new Set())).toThrow("parent");
  });

  it("rejects duplicate table names or exports and validates sibling references", () => {
    expect(() =>
      compileChildTables([...children, ...children], new Set(["parent"])),
    ).toThrow("Duplicate");
    const sibling = {
      name: "SyntheticSibling",
      exportName: "syntheticSibling",
      columns: [
        {
          key: "ownerId",
          kind: "uuid",
          reference: { table: "syntheticChild", column: "id" },
        },
      ],
    } as const;
    expect(
      compileChildTables([...children, sibling], new Set(["parent"])),
    ).toHaveLength(2);
    expect(() =>
      compileChildTables(
        [
          ...children,
          {
            ...sibling,
            columns: [
              {
                ...sibling.columns[0],
                reference: { table: "syntheticChild", column: "missing" },
              },
            ],
          },
        ],
        new Set(["parent"]),
      ),
    ).toThrow("missing");
  });
});
