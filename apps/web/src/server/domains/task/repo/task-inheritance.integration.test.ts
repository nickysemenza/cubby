import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  updateProject,
  readProjectById,
} from "~/server/domains/project/repo/crud";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { loadRelatedPreviews } from "~/server/generic/entity-links/repo/related-view";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { readTask, updateTask } from "./crud";
import { resolveDraftTaskFields } from "./task-project-inheritance";

describe("task inheritance", () => {
  const ctx = withTestDb();

  it("resolves parent fields live, protects None, and snapshots a detach", async () => {
    const first = await createRepoEntity(ctx, "project", {
      name: "inherit first",
      defaultTrade: "building",
    });
    const second = await createRepoEntity(ctx, "project", {
      name: "inherit second",
      defaultTrade: "plumbing",
    });
    const parent = await createRepoEntity(ctx, "task", {
      name: "inherit parent",
      projectId: first.output.id,
      trade: "electrical",
    });
    const child = await createRepoEntity(ctx, "task", {
      name: "inherit child",
      parentTaskId: parent.output.id,
    });
    expect(child.output).toMatchObject({
      projectId: first.output.id,
      trade: "electrical",
      fieldResolutions: { projectId: { mode: "inherit" } },
    });

    const relations = await loadRelatedPreviews(ctx.db, {
      source: "project",
      sourceIds: [first.output.id],
      relationKeys: ["project.tasks"],
    });
    expect(relations[0]?.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([parent.output.id, child.output.id]),
    );

    await updateTask(
      ctx.db,
      child.output.id,
      { projectId: null, projectMode: "explicit", trade: "electrical" },
      ctx.actor,
    );
    expect(await readTask(ctx.db, child.output.id)).toMatchObject({
      projectId: null,
      fieldResolutions: { projectId: { mode: "none" } },
    });

    await updateTask(
      ctx.db,
      child.output.id,
      { projectId: null, projectMode: "inherit" },
      ctx.actor,
    );
    await updateTask(
      ctx.db,
      parent.output.id,
      { projectId: second.output.id },
      ctx.actor,
    );
    expect(await readTask(ctx.db, child.output.id)).toMatchObject({
      projectId: second.output.id,
      trade: "electrical",
    });

    await updateTask(
      ctx.db,
      child.output.id,
      { parentTaskId: null },
      ctx.actor,
    );
    expect(await readTask(ctx.db, child.output.id)).toMatchObject({
      parentTaskId: null,
      projectId: second.output.id,
      trade: "electrical",
    });
  });
  it("distinguishes matching overrides, parent trades, and an explicit empty source", async () => {
    const first = await createRepoEntity(ctx, "project", {
      name: "Parent project",
      defaultTrade: "building",
    });
    const second = await createRepoEntity(ctx, "project", {
      name: "Independent project",
      defaultTrade: "plumbing",
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Task fixture product",
      brandId: await findOrCreateVendor(ctx.db, "Fixture brandName"),
    });
    const parent = await createRepoEntity(ctx, "task", {
      name: "Parent",
      projectId: first.output.id,
      subjectProductId: product.shortcode,
      trade: "electrical",
    });
    const child = await createRepoEntity(ctx, "task", {
      name: "Child",
      parentTaskId: parent.output.id,
      projectId: second.output.id,
    });
    expect(child.output).toMatchObject({
      projectId: second.output.id,
      subjectProductId: product.shortcode,
      trade: "plumbing",
      fieldResolutions: {
        projectId: { matchesFallback: false, fallbackValue: first.output.id },
        subjectProductId: { mode: "inherit", value: product.shortcode },
      },
    });
    await updateTask(
      ctx.db,
      child.output.id,
      { projectId: first.output.id },
      ctx.actor,
    );
    expect(await readTask(ctx.db, child.output.id)).toMatchObject({
      trade: "electrical",
      fieldResolutions: { projectId: { matchesFallback: true } },
    });
    await expect(
      updateTask(
        ctx.db,
        child.output.id,
        { projectId: null, projectMode: "explicit" },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    expect(await readTask(ctx.db, child.output.id)).toMatchObject({
      projectId: first.output.id,
    });
    const none = await resolveDraftTaskFields(
      ctx.db,
      buildEntity("task", {
        name: "Preview",
        parentTaskId: parent.output.id,
        projectId: null,
        projectMode: "explicit",
      }),
    );
    expect(none).toMatchObject({
      projectId: { mode: "none", value: null, fallbackValue: first.output.id },
      trade: { value: null },
    });
    await updateTask(
      ctx.db,
      child.output.id,
      { subjectProductId: null, subjectProductMode: "explicit" },
      ctx.actor,
    );
    expect(await readTask(ctx.db, child.output.id)).toMatchObject({
      subjectProductId: null,
      fieldResolutions: {
        subjectProductId: { mode: "none", matchesFallback: false },
      },
    });
    await updateTask(
      ctx.db,
      child.output.id,
      { subjectProductMode: "inherit" },
      ctx.actor,
    );
    const secondParent = await createRepoEntity(ctx, "task", {
      name: "New parent",
      projectId: second.output.id,
      trade: "landscaping",
    });
    await updateTask(
      ctx.db,
      child.output.id,
      { parentTaskId: secondParent.output.id, projectMode: "inherit" },
      ctx.actor,
    );
    expect(await readTask(ctx.db, child.output.id)).toMatchObject({
      projectId: second.output.id,
      subjectProductId: null,
      trade: "landscaping",
    });
  });

  it("preserves project settings on detach and refuses removing a required default", async () => {
    const parent = await createRepoEntity(ctx, "project", {
      name: "Site parent",
      locations: ["Test site"],
      defaultTrade: "building",
    });
    const child = await createRepoEntity(ctx, "project", {
      name: "Site child",
      parentProjectId: parent.output.id,
    });
    expect(child.output).toMatchObject({
      locations: ["Test site"],
      defaultTrade: "building",
      fieldResolutions: { locations: { mode: "inherit" } },
    });
    const task = await createRepoEntity(ctx, "task", {
      name: "Dependent task",
      projectId: child.output.id,
    });
    // A path default can itself inherit: provenance names the terminal decision,
    // and draft previews must agree with the saved read before any assignment.
    const expectedTradeResolution = {
      mode: "inherit",
      storedValue: null,
      value: "building",
      fallbackValue: "building",
      source: "Project default",
      sourceEntity: {
        entityKind: "project",
        entityId: parent.output.id,
        name: "Site parent",
      },
      matchesFallback: false,
      canReset: false,
    };
    expect(task.output.fieldResolutions?.trade).toEqual(
      expectedTradeResolution,
    );
    expect(
      (
        await resolveDraftTaskFields(ctx.db, {
          projectId: child.output.id,
          parentTaskId: null,
          subjectProductId: null,
          trade: null,
        })
      ).trade,
    ).toEqual(expectedTradeResolution);
    await expect(
      updateProject(
        ctx.db,
        parent.output.id,
        { defaultTrade: null },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "CONSTRAINT_VIOLATION" });
    await updateProject(
      ctx.db,
      child.output.id,
      { parentProjectId: null },
      ctx.actor,
    );
    await updateProject(
      ctx.db,
      parent.output.id,
      { defaultTrade: "plumbing", locations: ["Different site"] },
      ctx.actor,
    );
    expect(await readProjectById(ctx.db, child.entityId)).toMatchObject({
      locations: ["Test site"],
      defaultTrade: "building",
      fieldResolutions: {
        defaultTrade: { mode: "explicit", matchesFallback: false },
      },
    });
    expect(
      await readTask(ctx.db, parseShortcodeFor("task", task.output.id)),
    ).toMatchObject({ trade: "building" });
  });
});
