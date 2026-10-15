/** MCP must return the same score/gap transition as UI writes, retain source
 * explanations, reject blank notes, and stop honoring changed evidence. */
import { dataQuality } from "@cubby/schemas/data-quality";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { requireActor } from "~/server/http/request-context";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool } from "../testing/mcp-test-utils";
import { McpOperationContext } from "./operation-context";
import { createMcpServer } from "./server";

describe("availability explanations through MCP", () => {
  const ctx = withTestDb("mcp");
  it("accepts, clears, and invalidates the evidence-bound finding", async () => {
    const saved = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic unbranded container",
        manufacturer: "(unspecified)",
      }),
      ctx.actor,
    );
    const operationContext = new McpOperationContext(
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
    );
    const call = (action: "set" | "clear", note?: string) =>
      callMcpTool(
        createMcpServer(),
        "data_exception",
        {
          action,
          entityId: saved.id,
          check: "product_manufacturer",
          ...(action === "set" ? { reason: "unavailable", note } : {}),
        },
        {},
        { operationContext },
      );
    const before = (
      await loadDataQualities(ctx.db, "product", [saved.entityId])
    ).get(saved.entityId)!;
    expect((await call("set", " ")).isError).toBe(true);
    const note =
      "Checked [synthetic catalog](https://example.test/catalog); no manufacturer is available.";
    const accepted = dataQuality.parse(
      (await call("set", note)).structuredContent,
    );
    expect(accepted.score).toBeGreaterThan(before.score!);
    expect(accepted.gaps.map((gap) => gap.check)).not.toContain(
      "product_manufacturer",
    );
    expect(accepted.exceptions).toContainEqual(
      expect.objectContaining({ note, state: "active" }),
    );
    const cleared = dataQuality.parse((await call("clear")).structuredContent);
    expect(cleared.score).toBe(before.score);
    expect(cleared.gaps.map((gap) => gap.check)).toContain(
      "product_manufacturer",
    );
    await call("set", note);
    await getDb(ctx.db)
      .update(product)
      .set({ manufacturer: "Synthetic recorded maker" })
      .where(eq(product.id, saved.entityId));
    const changed = (
      await loadDataQualities(ctx.db, "product", [saved.entityId])
    ).get(saved.entityId)!;
    expect(changed.exceptions).toContainEqual(
      expect.objectContaining({ state: "stale" }),
    );
  });
});
