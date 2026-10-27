import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { photoRunImage, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { getEntityGraph } from "~/server/generic/entity-graph/repo/entity-graph";
import { getEntityGraphExplore } from "~/server/generic/entity-graph/repo/entity-graph-explore";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
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

  it("connects polymorphic subjects in both directions and through a third-level route", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic relationship brand",
    });
    const member = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic relationship member",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "vendorAccount", {
      vendorId: vendor.output.id,
      ledgerPartyId: member.output.id,
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
    expect(explored.nodes.map((node) => node.entityId)).toContain(
      account.output.id,
    );
    expect(
      explored.paths.some(
        (path) =>
          path.nodeRefs.map((ref) => ref.entityId).join(",") ===
          [
            execution.shortcode,
            target.id,
            vendor.output.id,
            account.output.id,
          ].join(","),
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
