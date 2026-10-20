import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadEntitySources,
  recordEntitySources,
} from "~/server/entity-kernel/repo/entity-source";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

// A patch citation is evidence for the edit, not a certificate for a whole list.
describe("collection patch Sources", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

  it("keeps patch evidence without loading or fingerprinting the collection", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic patch evidence" }),
      ctx.actor,
    );
    await recordEntitySources(ctx.db, {
      entityKind: "product",
      entityId: subject.entityId,
      recorder: ctx.actor,
      sources: [{ fieldPath: "tags", quote: "Synthetic compatible accessory" }],
    });
    for (const tags of [["Alpha", "Beta"], ["Gamma"], ["Alpha", "Beta"]]) {
      const sources = await loadEntitySources(ctx.db, "product", [
        { entityId: subject.entityId, detail: { tags } },
      ]);
      expect(sources.get(subject.entityId)).toEqual([
        expect.objectContaining({
          fieldPath: "tags",
          quote: "Synthetic compatible accessory",
          supportsCurrentValue: null,
        }),
      ]);
    }
  });
});
