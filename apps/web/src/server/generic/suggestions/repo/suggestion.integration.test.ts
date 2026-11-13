import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb } from "~/server/db/helpers";
import { image } from "~/server/db/schema";
import { confirmImageDescription } from "~/server/domains/image/repo/image-description-confirmation";
import { readConfirmedDescription } from "~/server/domains/image/repo/image-description-read";
import { loadSelectedDescriptionEvidence } from "~/server/domains/image/repo/image-description-selection";

describe("immutable image evidence", () => {
  const ctx = withTestDb();
  it("fences confirmed descriptions to current image content in direct and batch readers", async () => {
    const picture = await insertWithShortcode(ctx.db, "image", {
      key: "synthetic/content-fence.jpg",
      filename: "content-fence.jpg",
      size: 1,
      contentType: "image/jpeg",
      sha256: "a".repeat(64),
    });
    const first = {
      imageId: picture.id,
      contentHash: "a".repeat(64),
      description: "Superseded description",
      operationId: crypto.randomUUID(),
      expectedEffectId: null,
    };
    await confirmImageDescription(ctx.db, first, ctx.actor.userId);
    await confirmImageDescription(
      ctx.db,
      {
        ...first,
        description: "Confirmed description",
        operationId: crypto.randomUUID(),
        expectedEffectId: first.operationId,
      },
      ctx.actor.userId,
    );
    // A lost-response retry of the first confirmation must not overwrite the newer one.
    await expect(
      confirmImageDescription(ctx.db, first, ctx.actor.userId),
    ).rejects.toThrow(/description changed/);
    const readDirect = () =>
      readConfirmedDescription(ctx.db, parseEntityId("image", picture.id));
    const readBatch = async () =>
      (await loadSelectedDescriptionEvidence(ctx.db, [picture.shortcode])).get(
        picture.shortcode,
      );
    expect((await readDirect())?.description).toBe("Confirmed description");
    expect((await readBatch())?.description).toBe("Confirmed description");
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, picture.id));
    expect(await readDirect()).toBeNull();
    expect((await readBatch())?.description ?? null).toBeNull();
    expect(
      (
        await getDb(ctx.db).select().from(image).where(eq(image.id, picture.id))
      )[0]?.confirmedDescription,
    ).toBe("Confirmed description");
    await expect(
      confirmImageDescription(
        ctx.db,
        {
          imageId: picture.id,
          contentHash: "a".repeat(64),
          description: "Stale correction",
          operationId: crypto.randomUUID(),
          expectedEffectId: null,
        },
        ctx.actor.userId,
      ),
    ).rejects.toThrow(/evidence changed/);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "a".repeat(64), deletedAt: new Date() })
      .where(eq(image.id, picture.id));
    expect(await readDirect()).toBeNull();
    expect((await readBatch())?.description ?? null).toBeNull();
  });

  // Public history must never impersonate a private domain-application receipt.
});
