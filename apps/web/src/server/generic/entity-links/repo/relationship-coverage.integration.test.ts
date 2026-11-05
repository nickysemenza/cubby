import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { photoRunImage, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { createImageFixture } from "~/server/testing/repo.fixtures";

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
