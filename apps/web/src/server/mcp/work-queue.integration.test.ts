import { needsYouPage } from "@cubby/schemas/kernel/work";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { scopeState } from "~/server/db/kernel-schema";
import { requireActor } from "~/server/http/request-context";
import { createMcpServer } from "~/server/mcp/server";
import { callMcpTool } from "~/server/testing/mcp-test-utils";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

// The boundary exposes the kernel's member gaps, not a second queue projection.
describe("machinery.needsYou MCP read", () => {
  const ctx = withTestDb("mcp");

  it("pages public records with member gaps and their offered actions", async () => {
    const products = await Promise.all(
      ["first", "second", "automatic"].map((name) =>
        createProductIdentityFixture(
          ctx.db,
          makeProductInput({ name: `Synthetic ${name} gap product` }),
          ctx.actor,
        ),
      ),
    );
    for (const [index, product] of products.entries()) {
      const gap = {
        kind: "decision" as const,
        input: `Synthetic choice ${index}`,
        actor: index < 2 ? "you" : "cubby",
        since: `2026-01-0${index + 1}T00:00:00.000Z`,
        until: null,
        inputHash: null,
        actions: [
          {
            channel: "assignment" as const,
            kind: "none" as const,
            subject: `product:${product.entityId}`,
            field: "description",
            label: "Leave empty",
          },
        ],
      };
      await getDb(ctx.db)
        .insert(scopeState)
        .values({
          scopeKind: "fields",
          scopeKey: `product:${product.entityId}`,
          version: 1,
          rules: "synthetic-member-gap",
          stage: index < 2 ? "needs_you" : "waiting",
          gaps: [gap],
        })
        .onConflictDoUpdate({
          target: [scopeState.scopeKind, scopeState.scopeKey],
          set: { gaps: [gap], stage: index < 2 ? "needs_you" : "waiting" },
        });
    }
    const read = async (cursor?: string) => {
      const response = await callMcpTool(
        createMcpServer(),
        "machinery_read",
        {
          action: "needs_you",
          pageSize: 1,
          ...(cursor ? { cursor } : {}),
          resultDetail: "full",
        },
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
        {},
      );
      expect(response.isError).not.toBe(true);
      return needsYouPage
        .extend({ nextCursor: z.string().nullable() })
        .parse(response.structuredContent);
    };
    const first = await read();
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await read(first.nextCursor ?? "");
    expect(first.count).toBe(2);
    expect(second.count).toBe(2);
    expect(first.items).toEqual([
      expect.objectContaining({
        entity: "product",
        shortcode: products[0]?.id,
        stage: "needs_you",
        firstGap: "Synthetic choice 0",
        actions: [expect.objectContaining({ label: "Leave empty" })],
      }),
    ]);
    expect(second.items.map((item) => item.shortcode)).toEqual([
      products[1]?.id,
    ]);
    expect((await read(second.nextCursor ?? "")).items).toEqual([]);
  });
});
