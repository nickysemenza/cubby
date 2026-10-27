import { fromPartial } from "@total-typescript/shoehorn";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { DrizzleTransaction } from "~/server/db";
// Repository initialization belongs to suite startup, as it does in the server.
import "~/server/generated/entity-kernel-bindings.gen";

import { countSearchDocumentSources } from "./search-document";

describe("search document sources", () => {
  it("composes only requested source ports with their shared prefix and cutoff", async () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [{ count: 2 }] }));
    const db = fromPartial<DrizzleTransaction>({ execute, rollback: vi.fn() });
    const cutoff = "2026-01-02T00:00:00.000Z";

    expect(
      await countSearchDocumentSources(db, ["location", "expense"], cutoff),
    ).toBe(2);
    const queryArgument = execute.mock.calls[0]?.[0];
    if (!queryArgument) throw new Error("Search source query was not executed");
    const query = new PgDialect().sqlToQuery(queryArgument);
    expect(query.sql).toContain("WITH RECURSIVE location_path AS");
    expect(query.sql).toContain('FROM "Location" l');
    expect(query.sql).toContain('FROM "Expense" e');
    expect(query.sql).not.toContain('FROM "Image" i');
    expect(query.params).toContain(cutoff);
  });

  it("does not query when no kinds are selected", async () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [] }));
    const db = fromPartial<DrizzleTransaction>({ execute, rollback: vi.fn() });

    expect(
      await countSearchDocumentSources(db, [], "2026-01-02T00:00:00.000Z"),
    ).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
