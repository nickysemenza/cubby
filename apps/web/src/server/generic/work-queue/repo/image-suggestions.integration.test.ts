import { parseEntityId } from "@cubby/schemas/identifiers";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  assessmentState,
  image,
  job,
  feedback,
  vendorAccount,
} from "~/server/db/schema";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  readRecordWorkQueue,
  readWorkQueue,
} from "~/server/generic/work-queue/service/work-queue-read";
import { insertEntityAttachments } from "~/server/testing/repo.fixtures";

// Work must expose pending descriptions without inventing application authority,
// bypassing private original ownership, or scheduling correction work on reads.
describe("image Suggestions in Work", () => {
  const ctx = withTestDb();
  async function picture(name: string) {
    return insertWithShortcode(ctx.db, "image", {
      key: `synthetic/${name}.png`,
      filename: `${name}.png`,
      contentType: "image/png",
      size: 1,
      sha256: "a".repeat(64),
    });
  }
  async function propose(
    id: string,
    name: string,
    served = true,
    description = "Synthetic image description",
  ) {
    return publishAssessment(ctx.db, {
      publicationKey: `synthetic:image-work:${name}`,
      served,
      family: "image_description",
      subject: {
        kind: "image_description",
        entity: "image",
        recordId: id,
        contentHash: "a".repeat(64),
      },
      judgment: description,
      fingerprint: "a".repeat(64),
      producer: {
        kind: "model",
        model: "synthetic",
        revision: "1",
        runId: null,
        evaluationId: null,
      },
      evidence: null,
    });
  }
  const input = () =>
    workQueueHouseholdInput.parse({
      source: "suggestion",
      pageSize: 20,
    });

  it("shares Suggestions admission, counts one row per Image, scopes record strips and never writes on reads", async () => {
    const first = await picture("Synthetic first image work");
    const second = await picture("Synthetic second image work");
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic shared image product",
    });
    await insertEntityAttachments(ctx.db, [
      { entityId: product.id, imageId: first.id },
      { entityId: product.id, imageId: second.id },
    ]);
    await propose(first.id, "first-a");
    await propose(first.id, "first-b");
    await propose(first.id, "trial", false);
    await propose(first.id, "blank", true, "  ");
    const inactive = await propose(first.id, "inactive");
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ active: false })
      .where(eq(assessmentState.id, inactive.id));
    const suppressed = await propose(first.id, "suppressed");
    await getDb(ctx.db)
      .update(assessmentState)
      .set({
        suppression: {
          scope: "synthetic-image-description",
          candidateKey: "synthetic-suppressed",
          fingerprint: "a".repeat(64),
        },
      })
      .where(eq(assessmentState.id, suppressed.id));
    await propose(second.id, "second");
    const before = {
      jobs: await getDb(ctx.db).select().from(job),
      feedback: await getDb(ctx.db).select().from(feedback),
    };
    const queue = await readWorkQueue(ctx.db, null, input(), false);
    expect(queue.items).toHaveLength(2);
    expect(queue.items).toContainEqual(
      expect.objectContaining({
        entity: "image",
        id: first.shortcode,
        source: "suggestion",
        kind: "review",
        reason: "2 pending image descriptions",
        waitingFor: { kind: "either" },
      }),
    );
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "image_description",
          recordIds: [first.shortcode],
        })
      ).items,
    ).toHaveLength(2);
    const own = await readRecordWorkQueue(ctx.db, null, first.shortcode, false);
    expect(own.items.filter((row) => row.source === "suggestion")).toEqual([
      expect.objectContaining({
        id: first.shortcode,
        reason: "2 pending image descriptions",
      }),
    ]);
    expect({
      jobs: await getDb(ctx.db).select().from(job),
      feedback: await getDb(ctx.db).select().from(feedback),
    }).toEqual(before);
    await getDb(ctx.db)
      .update(image)
      .set({ deletedAt: new Date() })
      .where(eq(image.id, parseEntityId("image", second.id)));
    expect(
      (await readWorkQueue(ctx.db, null, input(), false)).items.map(
        (row) => row.id,
      ),
    ).toEqual([first.shortcode]);
  });

  it("retains private original routing and fails closed when its source owner disappears", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic image owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic image guest",
      kind: "guest",
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic image source vendor",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: member.id,
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
    });
    const source = await picture("Synthetic private image work");
    await insertEntityAttachments(ctx.db, {
      entityId: order.id,
      imageId: source.id,
    });
    await propose(source.id, "private");
    const household = await readWorkQueue(ctx.db, other.id, input(), false);
    expect(household.items).toEqual([
      expect.objectContaining({
        id: source.shortcode,
        waitingFor: {
          kind: "members",
          members: [{ id: member.shortcode, name: member.name }],
        },
      }),
    ]);
    expect(
      (await readWorkQueue(ctx.db, other.id, input(), true)).items,
    ).toEqual([]);
    expect(
      (await readWorkQueue(ctx.db, member.id, input(), true)).items,
    ).toHaveLength(1);
    await getDb(ctx.db)
      .update(vendorAccount)
      .set({ deletedAt: new Date() })
      .where(eq(vendorAccount.id, account.id));
    expect(
      (await readWorkQueue(ctx.db, member.id, input(), false)).items,
    ).toEqual([
      expect.objectContaining({
        waitingFor: expect.objectContaining({ kind: "unresolved" }),
      }),
    ]);
    expect(
      (await readWorkQueue(ctx.db, member.id, input(), true)).items,
    ).toEqual([]);
  });
});
