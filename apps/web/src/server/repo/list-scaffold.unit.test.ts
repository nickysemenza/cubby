import { isNotNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { task } from "~/server/db/schema";

import { renderWhereSql } from "./database-helpers/mock-db";
import { listScaffold } from "./list-scaffold";

describe("listScaffold", () => {
  const scaffold = listScaffold("task", task);

  describe("where", () => {
    it("narrows on nothing but soft-delete with no filters or computed conditions", () => {
      expect(renderWhereSql(scaffold.where({}))).toBeDefined();
    });

    it("applies a declared stored predicate (task.status)", () => {
      expect(renderWhereSql(scaffold.where({ status: "done" }))).toContain(
        '"status"',
      );
    });

    it("ANDs in caller-supplied computed conditions alongside declared predicates", () => {
      const sql = renderWhereSql(
        scaffold.where({ status: "done" }, [isNotNull(task.name)]),
      );
      expect(sql).toContain('"status"');
      expect(sql).toContain('"name"');
    });
  });

  describe("orderBy", () => {
    it("falls back to the id tie-breaker with no sorts requested", () => {
      const clauses = scaffold.orderBy([]);
      expect(clauses.length).toBeGreaterThan(0);
      expect(renderWhereSql(clauses.at(-1))).toContain('"id"');
    });

    it("orders by a field from the generated sort roster", () => {
      const clauses = scaffold.orderBy([{ orderBy: "name", direction: "asc" }]);
      expect(clauses.some((c) => renderWhereSql(c)?.includes('"name"'))).toBe(
        true,
      );
    });
  });

  describe("page", () => {
    it("converts pageIndex/pageSize into take/skip", () => {
      expect(scaffold.page({ pageIndex: 2, pageSize: 25 })).toEqual({
        take: 25,
        skip: 50,
      });
    });
  });
});
