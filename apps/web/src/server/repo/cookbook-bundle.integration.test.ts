import { upsertCookbookInput } from "@cubby/schemas/import-recipe";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { syntheticBundle } from "../../../tooling/cookbook-bundle-fixture";
import { getCookbookSource, upsertCookbook } from "./cookbook";

// Reimports must not fork a renamed source or replace a different book solely
// because its title matches. Ambiguous existing source identities need review.
describe("bundle cookbook identity", () => {
  const ctx = withTestDb();
  it("reuses a source hash across filenames and refuses a same-title different source", async () => {
    const fixture = syntheticBundle();
    const first = await upsertCookbook(
      ctx.db,
      upsertCookbookInput.parse({
        name: "Original title",
        rawJson: fixture.cookbook,
        report: fixture.report,
        sourceLabel: "first.cookbook",
        bundleManifest: fixture.manifest,
      }),
      ctx.actor,
    );
    const second = await upsertCookbook(
      ctx.db,
      upsertCookbookInput.parse({
        name: "Renamed source",
        rawJson: fixture.cookbook,
        report: fixture.report,
        sourceLabel: "renamed.cookbook",
        bundleManifest: fixture.manifest,
      }),
      ctx.actor,
    );
    expect(second.output.id).toBe(first.output.id);
    const changed = {
      ...fixture.cookbook,
      source: { ...fixture.cookbook.source, sha256: "b".repeat(64) },
    };
    await expect(
      upsertCookbook(
        ctx.db,
        upsertCookbookInput.parse({
          name: "Original title",
          rawJson: changed,
          report: fixture.report,
          sourceLabel: "other.cookbook",
          bundleManifest: {
            ...fixture.manifest,
            source_sha256: changed.source.sha256,
          },
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/different source|distinct name/i);
    expect(
      (await getCookbookSource(ctx.db, first.entityId)).cookbook.source.sha256,
    ).toBe(fixture.cookbook.source.sha256);
  });
  it("accepts a reviewed explicit target and stores manifest evidence for photo checks", async () => {
    const fixture = syntheticBundle();
    const first = await upsertCookbook(
      ctx.db,
      upsertCookbookInput.parse({
        name: "Reviewed target",
        rawJson: fixture.cookbook,
        sourceLabel: "first.cookbook",
      }),
      ctx.actor,
    );
    const source = {
      ...fixture.cookbook,
      source: { ...fixture.cookbook.source, sha256: "b".repeat(64) },
    };
    const result = await upsertCookbook(
      ctx.db,
      upsertCookbookInput.parse({
        name: "Reviewed target",
        cookbookId: first.output.id,
        rawJson: source,
        report: fixture.report,
        sourceLabel: "replacement.cookbook",
        bundleManifest: {
          ...fixture.manifest,
          source_sha256: source.source.sha256,
        },
      }),
      ctx.actor,
    );
    expect(result.output.id).toBe(first.output.id);
    expect(
      (await getCookbookSource(ctx.db, first.entityId)).cookbook.bundleManifest,
    ).toMatchObject({ source_sha256: source.source.sha256 });
  });
});
