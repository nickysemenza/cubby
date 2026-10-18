import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * A create already holds the uuid it inserted; resolving its own fresh
 * shortcode back to that uuid is one wasted round trip per create (two for
 * products, which did it in the write and again in the repository).
 */
describe("entity kernel create", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const ownCodeLookups = (statements: string[], table: string) =>
    statements.filter((statement) =>
      statement.startsWith(
        `select "id" from "${table}" where ("${table}"."shortcode" = $1`,
      ),
    );

  it("does not resolve a new location's own code", async () => {
    const { result, statements } = await countTestDbQueries(() =>
      executeEntity(context(), {
        action: "create",
        entity: "location",
        data: makeLocationInput({ name: "Readback room" }),
      }),
    );
    expect(result.action).toBe("create");
    expect(ownCodeLookups(statements, "Location")).toEqual([]);
  });

  it("does not resolve a new product's own code", async () => {
    const { result, statements } = await countTestDbQueries(() =>
      executeEntity(context(), {
        action: "create",
        entity: "product",
        data: makeProductInput({ name: "Readback product" }),
      }),
    );
    expect(result.action).toBe("create");
    expect(ownCodeLookups(statements, "Product")).toEqual([]);
  });
});
