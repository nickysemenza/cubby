import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { runDiagnostic } from "~/server/generic/problems/service/problem-diagnostics.service";
import { findProblemByType } from "~/server/generic/problems/service/problem-execution.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  runFinding,
  patchRunFindingData,
  seedRunFindings,
} from "~/server/testing/run-finding.fixtures";

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
    const target = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic diagnostic target",
      }),
      ctx.actor,
    );
    await seedRunFindings(
      ctx.db,
      Array.from({ length: 16 }, (_, index) => ({
        ledgerPartyId: party.id,
        entityKind: "product" as const,
        entityId: target.entityId,
        kind: "other" as const,
        summary: `Synthetic diagnostic finding ${index}`,
        evidenceFingerprint: `synthetic-diagnostic-${index}`,
      })),
    );
    // PostgreSQL retains timestamp precision that the driver truncates in Date values.
    const ordered = await getDb(ctx.db)
      .select({ id: runFinding.id })
      .from(runFinding)
      .orderBy(runFinding.createdAt, runFinding.id);
    const last = ordered.at(-1);
    if (!last) throw new Error("Synthetic finding fixture is empty");
    await patchRunFindingData(ctx.db, last.id, {
      proposedFix: { syntheticInvalidFix: true },
    });

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
    const clients = createTestRequestContext(ctx.db);
    const focused = await findProblemByType(
      ctx.db,
      "runFindings",
      clients.upcLookupClient,
      clients.usdaClient,
    );
    expect(focused.type).toBe("runFindings");
    expect(focused.total).toBe(16);
    expect(focused.items).toEqual(
      ordered.slice(0, 12).map(({ id }) => expect.objectContaining({ id })),
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
    await expect(
      runDiagnostic(
        ctx.db,
        "import-findings",
        {},
        {
          kind: "sample",
          limit: Number.POSITIVE_INFINITY,
        },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(findOpenRunFindings(ctx.db)).rejects.toBeInstanceOf(
      z.ZodError,
    );
  });
});
