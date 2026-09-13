import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { getSearchDocumentEmbeddingText } from "~/server/repo/search-document";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * A search document is written by the same request that writes the entity —
 * inside the kernel's transaction — never by a queue task that might not run.
 * A recording queue (nothing runs inline) proves the projection can only have
 * come from the write path itself.
 */
describe("entity kernel search projections", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  afterEach(() => setCfEnv(undefined));

  const recordingQueue = () => {
    const published: Array<{ task: { kind: string } }> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: { task: { kind: string } } }>,
          ) => {
            published.push(...[...messages].map((m) => m.body));
          },
        },
      }),
    );
    return published;
  };

  it("projects on create and re-projects on update before responding", async () => {
    const published = recordingQueue();
    const created = await executeEntity(context(), {
      action: "create",
      entity: "ingredient",
      data: {
        name: "Projected saffron",
        aliases: [],
        naKinds: [],
        usuallyOnHand: false,
      },
    });
    if (created.action !== "create") throw new Error("expected create");
    const entityId = await resolveLiveShortcode(
      ctx.db,
      created.item.id,
      "ingredient",
    );
    if (!entityId) throw new Error("created ingredient did not resolve");
    const first = await getSearchDocumentEmbeddingText(
      ctx.db,
      "ingredient",
      entityId,
    );
    expect(first?.embeddingText).toContain("Projected saffron");

    await executeEntity(context(), {
      action: "update",
      entity: "ingredient",
      id: parseShortcodeFor("ingredient", created.item.id),
      data: { name: "Projected turmeric" },
    });
    const second = await getSearchDocumentEmbeddingText(
      ctx.db,
      "ingredient",
      entityId,
    );
    expect(second?.embeddingText).toContain("Projected turmeric");
    expect(second?.embeddingText).not.toContain("Projected saffron");

    // The embedding is the only work handed to the queue; the projection
    // was already current when the response returned.
    expect(published.map((message) => message.task.kind)).toEqual([
      "entity-embedding.refresh",
      "entity-embedding.refresh",
    ]);
  });
});
