import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluationRequest,
  photoRunImage,
  product,
  run,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { getEntityGraph } from "~/server/generic/entity-graph/repo/entity-graph";
import { getEntityGraphExplore } from "~/server/generic/entity-graph/repo/entity-graph-explore";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
import {
  createImageFixture,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { getConnectedRecords } from "./connected-records";

describe("relationship evidence coverage", () => {
  const ctx = withTestDb();
  const makeRun = async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const [row] = await getDb(ctx.db).select().from(run).where(eq(run.id, id));
    if (!row) throw new Error("Synthetic Run missing");
    return row;
  };

  it("retains all shared request Runs, both Product-pair targets and deleted target evidence", async () => {
    const first = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic first target" }),
      ctx.actor,
    );
    const second = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic second target" }),
      ctx.actor,
    );
    const requester = await makeRun();
    const other = await makeRun();
    const input = {
      runId: requester.id,
      executionKind: "suggestion_sweep" as const,
      shareKey: "synthetic-shared-pair",
      feature: "synthetic-pair",
      target: {
        kind: "product_pair" as const,
        entity: "product" as const,
        recordId: first.entityId,
        otherId: second.entityId,
        field: null,
        assessmentIds: [],
      },
      provenance: {
        dependencies: [],
        inputFingerprint: "synthetic",
        optionFingerprint: "synthetic",
        model: null,
      },
      snapshot: {},
    };
    const evaluation = await enqueueAiEvaluation(ctx.db, input);
    expect(
      (await enqueueAiEvaluation(ctx.db, { ...input, runId: other.id })).id,
    ).toBe(evaluation.id);
    const execution = await enqueueJob(ctx.db, {
      key: `ai-evaluation:${evaluation.id}`,
      kind: "ai.evaluation",
      input: { evaluationId: evaluation.id },
    });
    expect(execution.runId).toBeNull();
    const source = {
      entityKind: "job" as const,
      entityId: execution.shortcode,
    };
    const requests = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:run",
    });
    expect(requests.items.map((item) => item.target.entityId).sort()).toEqual(
      [requester.shortcode, other.shortcode].sort(),
    );
    const targets = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:product",
    });
    expect(targets.items.map((item) => item.target.entityId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    const inverse = await getConnectedRecords(ctx.db, {
      source: { entityKind: "product", entityId: second.id },
      viewKey: "entity:job",
    });
    expect(inverse.items.map((item) => item.target.entityId)).toContain(
      execution.shortcode,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, second.entityId));
    const retained = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:product",
    });
    expect(
      retained.items.find((item) => item.target.entityId === second.id)?.target
        .label,
    ).toContain("(deleted)");
    // Older retained evaluations can predate per-request membership.
    await getDb(ctx.db)
      .delete(aiEvaluationRequest)
      .where(eq(aiEvaluationRequest.evaluationId, evaluation.id));
    const legacy = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:run",
    });
    expect(legacy.items.map((item) => item.target.entityId)).toEqual([
      requester.shortcode,
    ]);
  });

  it("connects polymorphic subjects in both directions and through a third-level route", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic relationship brand",
    });
    expect(
      (
        await getConnectedRecords(ctx.db, {
          source: { entityKind: "vendor", entityId: vendor.output.id },
          viewKey: "entity:email",
        })
      ).totalCount,
    ).toBe(0);
    const target = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic embedded product",
        brandId: vendor.output.id,
      }),
      ctx.actor,
    );
    const execution = await enqueueJob(ctx.db, {
      key: "synthetic-embedding",
      kind: "embedding.refresh",
      subjectKind: "product",
      subjectId: target.entityId,
      input: {},
    });
    const source = {
      entityKind: "job" as const,
      entityId: execution.shortcode,
    };
    const related = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:product",
    });
    expect(related.items.map((item) => item.target.entityId)).toEqual([
      target.id,
    ]);
    const inverse = await getEntityGraph(ctx.db, {
      roots: [{ entityKind: "product", entityId: target.id }],
      entityKinds: ["job"],
    });
    expect(inverse.nodes.map((node) => node.entityId)).toContain(
      execution.shortcode,
    );
    const explored = await getEntityGraphExplore(ctx.db, {
      root: source,
      depth: 3,
    });
    expect(explored.nodes.map((node) => node.entityId)).toContain(
      vendor.output.id,
    );
    expect(
      explored.paths.some(
        (path) =>
          path.nodeRefs.map((ref) => ref.entityId).join(",") ===
          [execution.shortcode, target.id, vendor.output.id].join(","),
      ),
    ).toBe(true);
    const nonEntity = await enqueueJob(ctx.db, {
      key: "synthetic-calendar",
      kind: "synthetic",
      subjectKind: "calendar",
      subjectId: "synthetic-origin",
      input: {},
    });
    const graph = await getEntityGraph(ctx.db, {
      roots: [{ entityKind: "job", entityId: nonEntity.shortcode }],
      entityKinds: ["product"],
    });
    expect(graph.edges).toEqual([]);
  });

  it("exposes photo membership without requiring a processing Job", async () => {
    const owner = await makeRun();
    const image = await createImageFixture(ctx.db, "synthetic-source-photo");
    await getDb(ctx.db)
      .insert(photoRunImage)
      .values({
        runId: owner.id,
        imageId: parseEntityId("image", image.id),
        position: 0,
        targetFingerprint: "a".repeat(64),
      });
    const forward = await getConnectedRecords(ctx.db, {
      source: { entityKind: "run", entityId: owner.shortcode },
      viewKey: "entity:image",
    });
    expect(forward.items.map((item) => item.target.entityId)).toEqual([
      image.shortcode,
    ]);
    const inverse = await getConnectedRecords(ctx.db, {
      source: { entityKind: "image", entityId: image.shortcode },
      viewKey: "entity:run",
    });
    expect(inverse.items.map((item) => item.target.entityId)).toEqual([
      owner.shortcode,
    ]);
  });
});
