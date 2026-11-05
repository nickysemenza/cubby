import { parseEntityId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { USDAClient } from "~/server/clients/usda";
import type { UsdaReleaseRpc } from "~/server/domains/usda-release/operations/rpc";
import { derivedSink } from "~/server/generic/derived/repo/compute";
import { readDerivedRebuildStatus } from "~/server/generic/derived/repo/rebuild";
import { rebuildDerived } from "~/server/generic/derived/service/rebuild";
import { prepareProductConversionCoverage } from "~/server/generic/problems/service/problems.service";
import { getSearchDocumentEmbeddingText } from "~/server/generic/search/repo/search-document";
import { derivedComputes } from "~/server/workflows/derived-computes";

const offlineUsda = new USDAClient(
  fromPartial<UsdaReleaseRpc>({
    lookupBatch: async (lookups: readonly unknown[]) => lookups.map(() => null),
    search: async () => ({ data: [], count: 0 }),
  }),
);
const computes = {
  ...derivedComputes,
  "product.conversionCoverage": derivedSink({
    prepare: (db, ids) =>
      prepareProductConversionCoverage(
        db,
        ids.map((id) => parseEntityId("product", id)),
        offlineUsda,
      ),
    publish: (tx, ids, prepared) => prepared.publish(tx, ids),
  }),
};
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { repairSearchIndex } from "./search-index-repair.service";

// A member repair survives a disconnected reader and uses the ordinary deterministic pass.
describe("search repair admission", () => {
  const ctx = withTestDb();
  it("streams derived drain results while workers rebuild authoritative search text", async () => {
    const subject = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic repair subject" }),
      ctx.actor,
    );
    const stream = repairSearchIndex(ctx.db);
    const first = await stream.next();
    if (first.done) throw new Error("Expected repair progress");
    expect(first.value).toMatchObject({ type: "progress", phase: "sources" });
    for (let page = 0; page < 1_000; page++) {
      if (!(await rebuildDerived(ctx.db, computes))) break;
      if (page === 999)
        throw new Error("Synthetic search repair exceeded its page bound");
    }
    let last = await stream.next();
    while (!last.done && last.value.type !== "done") last = await stream.next();
    if (last.done) throw new Error("Expected repair completion event");
    expect(last.value.type).toBe("done");
    expect(
      (
        await getSearchDocumentEmbeddingText(
          ctx.db,
          "product",
          subject.entityId,
        )
      )?.embeddingText,
    ).toContain("Synthetic repair subject");
    await stream.return();
  });

  it("leaves committed work queued after its status reader disconnects", async () => {
    const controller = new AbortController();
    const stream = repairSearchIndex(ctx.db, controller.signal);
    await stream.next();
    controller.abort();
    await expect(stream.next()).rejects.toThrow(/cancelled/i);
    expect((await readDerivedRebuildStatus(ctx.db)).running).toBe(true);
  });
});
