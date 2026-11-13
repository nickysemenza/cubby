/** MCP must return the same gap transition as UI writes, retain source
 * explanations, reject blank notes, and stop honoring changed evidence. */
import { dataQuality } from "@cubby/schemas/data-quality";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { setFieldsFixture } from "~/server/ai/fields/fields.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { requireActor } from "~/server/http/request-context";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool } from "../testing/mcp-test-utils";
import { createMcpServer } from "./server";

describe("availability explanations through MCP", () => {
  const ctx = withTestDb("mcp");
  it("accepts, clears, and retains the finding across evidence changes", async () => {
    const saved = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic unbranded container",
        brandId: null,
      }),
      ctx.actor,
    );
    const mcpContext = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const call = (action: "set" | "clear", note?: string) =>
      callMcpTool(
        createMcpServer(),
        "data_exception",
        {
          action: `${action}_exception`,
          entityId: saved.id,
          check: "product_brand",
          ...(action === "set" ? { reason: "unavailable", note } : {}),
        },
        mcpContext,
      );
    expect((await call("set", " ")).isError).toBe(true);
    const note =
      "Checked [synthetic catalog](https://example.test/catalog); no brandName is available.";
    const accepted = dataQuality.parse(
      (await call("set", note)).structuredContent,
    );
    expect(accepted.gaps.map((gap) => gap.check)).not.toContain(
      "product_brand",
    );
    expect(accepted.exceptions).toContainEqual(
      expect.objectContaining({ note, state: "active" }),
    );
    const cleared = dataQuality.parse((await call("clear")).structuredContent);
    expect(cleared.gaps.map((gap) => gap.check)).toContain("product_brand");
    await call("set", note);
    await setFieldsFixture(ctx.db, "product", saved.entityId, {
      brandId: await findOrCreateVendor(ctx.db, "Synthetic recorded maker"),
    });
    const changed = (
      await loadDataQualities(ctx.db, "product", [saved.entityId])
    ).get(saved.entityId)!;
    // Waivers never reopen: the decision stays active after the evidence changes.
    expect(changed.exceptions).toContainEqual(
      expect.objectContaining({ note, state: "active" }),
    );
  });
});
