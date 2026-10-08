import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, asc, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  expense,
  inventoryEntry,
  product,
  run,
  runEvidence,
  runFactEvidence,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { admitProductResearch } from "./product-research-run";
import {
  retainResearchObservation,
  type ResearchObservationPorts,
} from "./research-observations";
import { resolveProductResearch } from "./research-product";
import { researchServiceFor } from "./research-service";

// Shared admission must not borrow another task's original, lose accepted
// matching-value proof, repeat writes, or finish successfully with unresolved work.
describe("same-Run Product research isolation", () => {
  const ctx = withTestDb();
  it("preserves accepted facts and proof while another selected Product remains unresolved", async () => {
    const database = getDb(ctx.db);
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic batch member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const items = [];
    for (const name of ["Synthetic small device", "Synthetic large device"]) {
      items.push(
        await createProductFixture(
          ctx.db,
          makeProductInput({
            name,
            manufacturer: "Example Works",
            model: "",
          }),
          ctx.actor,
        ),
      );
    }
    const admissions = await admitProductResearch(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      productIds: items.map((item) => item.entityId),
      cause: "member_request",
    });
    expect(admissions).toHaveLength(1);
    const admitted = admissions[0]!;
    expect(admitted.created).toBe(true);
    expect(
      productResearchRunInput.parse(admitted.run.input).products,
    ).toHaveLength(2);
    const frozenInput = structuredClone(admitted.run.input);
    const targets = await database
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, admitted.run.id))
      .orderBy(asc(runTarget.id));
    expect(targets).toHaveLength(2);
    const bytes = new Map<string, Uint8Array>();
    const storage = {
      put: async (key, content) => {
        bytes.set(key, content);
      },
      get: async (key) => {
        const stored = bytes.get(key);
        if (!stored) throw new Error("Synthetic retained bytes missing");
        return new TextDecoder().decode(stored);
      },
    } satisfies NonNullable<ResearchObservationPorts["storage"]>;
    const service = researchServiceFor(
      ctx.db,
      fromPartial<Env>({}),
      admitted.run.id,
      {
        observations: { storage },
      },
    );
    const next = z.object({
      status: z.literal("working"),
      work: z.object({ workRef: z.uuid() }),
    });
    const firstWork = next.parse(
      await service.researchNext({}, crypto.randomUUID()),
    );
    const first = targets.find(
      (target) => target.id === firstWork.work.workRef,
    );
    const second = targets.find(
      (target) => target.id !== firstWork.work.workRef,
    );
    if (!first || !second) throw new Error("Synthetic batch targets missing");
    const firstProduct = items.find((item) => item.entityId === first.entityId);
    const secondProduct = items.find(
      (item) => item.entityId === second.entityId,
    );
    if (!firstProduct || !secondProduct)
      throw new Error("Synthetic task Product missing");
    const originalSecond = await database
      .select()
      .from(product)
      .where(eq(product.id, secondProduct.entityId));
    const retainedFirst = await retainResearchObservation(
      ctx.db,
      {
        runId: admitted.run.id,
        workRef: first.id,
        callId: crypto.randomUUID(),
        kind: "web_page",
        sourceMetadata: {
          sourceURL: "https://catalog.example.test/selected-first",
        },
        content:
          "<main>Selected synthetic device. Manufacturer Example Works. Exact model BATCH-17.</main>",
      },
      { storage },
    );
    const retainedSecond = await retainResearchObservation(
      ctx.db,
      {
        runId: admitted.run.id,
        workRef: second.id,
        callId: crypto.randomUUID(),
        kind: "web_page",
        sourceMetadata: {
          sourceURL: "https://catalog.example.test/selected-second",
        },
        content:
          "<main>Two plausible synthetic devices. The exact model and ordered variant remain unknown.</main>",
      },
      { storage },
    );
    const support = {
      observation: "Manufacturer Example Works. Exact model BATCH-17.",
      reasoning: "The retained original identifies this selected device.",
    };
    const firstProposal = {
      workRef: first.id,
      status: "partially_verified" as const,
      identity: {
        evidenceIds: [retainedFirst.evidenceId],
        reasoning: support.reasoning,
      },
      facts: [
        {
          fieldPath: "manufacturer",
          value: "Example Works",
          evidenceId: retainedFirst.evidenceId,
          support,
        },
        {
          fieldPath: "model",
          value: "BATCH-17",
          evidenceId: retainedFirst.evidenceId,
          support,
        },
      ],
      detail:
        "Supported manufacturer and model; catalog coverage still has gaps.",
    };
    const accepted = {
      identityVerified: true,
      acceptedFacts: [0, 1],
      acceptedIdentifiers: [],
      acceptedImages: [],
      rejected: [],
    };
    const ports = {
      readEvidence: async (row: typeof runEvidence.$inferSelect) =>
        storage.get(row.objectKey),
      assess: async () => accepted,
    };
    await expect(
      resolveProductResearch(
        ctx.db,
        {
          runId: admitted.run.id,
          callId: crypto.randomUUID(),
          proposal: { ...firstProposal, workRef: second.id },
        },
        ports,
      ),
    ).rejects.toThrow(/work|task|scope/iu);
    expect(await database.select().from(runFactEvidence)).toEqual([]);
    expect(
      await database
        .select()
        .from(product)
        .where(eq(product.id, secondProduct.entityId)),
    ).toEqual(originalSecond);
    const firstCallId = crypto.randomUUID();
    const acceptedResult = await resolveProductResearch(
      ctx.db,
      {
        runId: admitted.run.id,
        callId: firstCallId,
        proposal: firstProposal,
      },
      ports,
    );
    expect(acceptedResult).toMatchObject({
      outcome: "partially_verified",
      changedFields: ["model"],
      verifiedFields: ["manufacturer", "model"],
    });
    expect(
      await service.researchResolve(firstProposal, firstCallId),
    ).toMatchObject({
      status: "working",
      work: { workRef: second.id },
    });
    expect(
      (await database.select().from(run).where(eq(run.id, admitted.run.id)))[0],
    ).toMatchObject({ status: "running", endedAt: null });
    const secondCallId = crypto.randomUUID();
    const secondProposal = {
      workRef: second.id,
      status: "ambiguous" as const,
      identity: {
        evidenceIds: [retainedSecond.evidenceId],
        reasoning: "The source does not distinguish the two variants.",
      },
      detail:
        "The second Product has no supported exact variant; preserve its current fields.",
    };
    await resolveProductResearch(
      ctx.db,
      {
        runId: admitted.run.id,
        callId: secondCallId,
        proposal: secondProposal,
      },
      {
        readEvidence: ports.readEvidence,
        assess: async () => ({
          ...accepted,
          identityVerified: false,
          acceptedFacts: [],
        }),
      },
    );
    expect(
      await service.researchResolve(secondProposal, secondCallId),
    ).toMatchObject({
      status: "done",
      summary: { verified: 0, partiallyVerified: 1, unresolved: 2 },
    });
    const [settled] = await database
      .select()
      .from(run)
      .where(eq(run.id, admitted.run.id));
    expect(settled).toMatchObject({
      status: "needs_review",
      endedAt: expect.any(Date),
      input: frozenInput,
    });
    expect(
      await database
        .select()
        .from(product)
        .where(eq(product.id, secondProduct.entityId)),
    ).toEqual(originalSecond);
    const [supported] = await database
      .select()
      .from(product)
      .where(eq(product.id, firstProduct.entityId));
    expect(supported).toMatchObject({
      manufacturer: "Example Works",
      model: "BATCH-17",
    });
    const proof = await database
      .select()
      .from(runFactEvidence)
      .orderBy(asc(runFactEvidence.fieldPath));
    expect(proof).toHaveLength(2);
    expect(proof).toMatchObject([
      {
        targetId: first.id,
        entityKind: "product",
        entityId: first.entityId,
        fieldPath: "manufacturer",
        value: "Example Works",
        evidenceId: retainedFirst.evidenceId,
      },
      {
        targetId: first.id,
        entityKind: "product",
        entityId: first.entityId,
        fieldPath: "model",
        value: "BATCH-17",
        evidenceId: retainedFirst.evidenceId,
      },
    ]);
    expect(
      await resolveProductResearch(
        ctx.db,
        {
          runId: admitted.run.id,
          callId: firstCallId,
          proposal: firstProposal,
        },
        ports,
      ),
    ).toEqual(acceptedResult);
    expect(
      await database
        .select()
        .from(runFactEvidence)
        .orderBy(asc(runFactEvidence.fieldPath)),
    ).toEqual(proof);
    expect(
      await database
        .select()
        .from(runTarget)
        .where(
          and(
            eq(runTarget.runId, admitted.run.id),
            eq(runTarget.id, second.id),
          ),
        ),
    ).toMatchObject([{ state: "unresolved", outcome: "ambiguous" }]);
    expect(await database.select().from(expense)).toEqual([]);
    expect(await database.select().from(inventoryEntry)).toEqual([]);
  });
});
