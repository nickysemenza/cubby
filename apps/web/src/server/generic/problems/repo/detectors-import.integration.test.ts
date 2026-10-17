import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { runFinding } from "~/server/db/schema";
import { runDiagnostic } from "~/server/generic/problems/service/problem-diagnostics.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { findOpenRunFindings } from "./detectors-import";

describe("SQL-backed finding diagnostic intent", () => {
  const ctx = withTestDb();

  it("returns exact zero totals for an empty sample", async () => {
    const sample = await runDiagnostic(
      ctx.db,
      "import-findings",
      {},
      { kind: "sample", limit: 3 },
    );
    expect(sample.items).toEqual([]);
    expect(sample.count).toBe(0);
    expect(
      (await runDiagnostic(ctx.db, "import-findings", {}, { kind: "count" }))
        .count,
    ).toBe(0);
  });

  // Counts and earlier pages depend on membership, not off-page fix payloads.
  // A selected malformed fix must still fail with its original validation error.
  it("counts and samples without parsing unselected finding payloads", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      userId: ctx.actor.userId,
      name: "Synthetic diagnostic owner",
    });
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic diagnostic target",
      }),
      ctx.actor,
    );
    const rows = await getDb(ctx.db)
      .insert(runFinding)
      .values(
        Array.from({ length: 16 }, (_, index) => ({
          ledgerPartyId: party.id,
          entityKind: "product" as const,
          entityId: target.entityId,
          kind: "other" as const,
          summary: `Synthetic diagnostic finding ${index}`,
          evidenceFingerprint: `synthetic-diagnostic-${index}`,
          createdAt: new Date(
            Date.UTC(2026, 8, 20, 12, 0, Math.floor(index / 2)),
          ),
        })),
      )
      .returning({ id: runFinding.id, createdAt: runFinding.createdAt });
    const ordered = [...rows].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
    const last = rows.at(-1);
    if (!last) throw new Error("Synthetic finding fixture is empty");
    await getDb(ctx.db)
      .update(runFinding)
      .set({
        proposedFix: sql`jsonb_build_object('syntheticInvalidFix', true)`,
      })
      .where(eq(runFinding.id, last.id));

    const count = await runDiagnostic(
      ctx.db,
      "import-findings",
      {},
      { kind: "count" },
    );
    expect(count.count).toBe(16);
    const sample = await runDiagnostic(
      ctx.db,
      "import-findings",
      {},
      { kind: "sample", limit: 3 },
    );
    expect(sample.count).toBe(16);
    expect(sample.items).toEqual(
      ordered.slice(0, 3).map(({ id }) => expect.objectContaining({ id })),
    );
    const empty = await runDiagnostic(
      ctx.db,
      "import-findings",
      {},
      { kind: "sample", limit: 0 },
    );
    expect(empty.items).toEqual([]);
    expect(empty.count).toBe(16);
    await expect(
      runDiagnostic(
        ctx.db,
        "import-findings",
        {},
        { kind: "sample", limit: 16 },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(findOpenRunFindings(ctx.db)).rejects.toBeInstanceOf(
      z.ZodError,
    );
  });
});
