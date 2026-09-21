import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createProject, updateProject, getProjectByID } from "./project";
import { loadRelatedPreviews } from "./related-view";
import { insertWithShortcode } from "./shortcode-utils";
import { createTask, getTaskByShortcode, updateTask } from "./task";
import { resolveDraftTaskFields } from "./task-project-inheritance";

describe("task inheritance", () => {
  const ctx = withTestDb();

  it("resolves parent fields live, protects None, and snapshots a detach", async () => {
    const first = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "inherit first",
        defaultTrade: "building",
      }),
      ctx.actor,
    );
    const second = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "inherit second",
        defaultTrade: "plumbing",
      }),
      ctx.actor,
    );
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "inherit parent",
        projectId: first.output.id,
        trade: "electrical",
      }),
      ctx.actor,
    );
    const child = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "inherit child",
        parentTaskId: parent.output.id,
      }),
      ctx.actor,
    );
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
    expect(await getTaskByShortcode(ctx.db, child.output.id)).toMatchObject({
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
    expect(await getTaskByShortcode(ctx.db, child.output.id)).toMatchObject({
      projectId: second.output.id,
      trade: "electrical",
    });

    await updateTask(
      ctx.db,
      child.output.id,
      { parentTaskId: null },
      ctx.actor,
    );
    expect(await getTaskByShortcode(ctx.db, child.output.id)).toMatchObject({
      parentTaskId: null,
      projectId: second.output.id,
      trade: "electrical",
    });
  });
  it("distinguishes matching overrides, parent trades, and an explicit empty source", async () => {
    const first = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Parent project",
        defaultTrade: "building",
      }),
      ctx.actor,
    );
    const second = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Independent project",
        defaultTrade: "plumbing",
      }),
      ctx.actor,
    );
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Task fixture product",
      manufacturer: "Fixture manufacturer",
    });
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Parent",
        projectId: first.output.id,
        subjectProductId: product.shortcode,
        trade: "electrical",
      }),
      ctx.actor,
    );
    const child = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Child",
        parentTaskId: parent.output.id,
        projectId: second.output.id,
      }),
      ctx.actor,
    );
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
    expect(await getTaskByShortcode(ctx.db, child.output.id)).toMatchObject({
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
    expect(await getTaskByShortcode(ctx.db, child.output.id)).toMatchObject({
      projectId: first.output.id,
    });
    const none = await resolveDraftTaskFields(
      ctx.db,
      taskCreateInput.parse({
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
    expect(await getTaskByShortcode(ctx.db, child.output.id)).toMatchObject({
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
    const secondParent = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "New parent",
        projectId: second.output.id,
        trade: "landscaping",
      }),
      ctx.actor,
    );
    await updateTask(
      ctx.db,
      child.output.id,
      { parentTaskId: secondParent.output.id, projectMode: "inherit" },
      ctx.actor,
    );
    expect(await getTaskByShortcode(ctx.db, child.output.id)).toMatchObject({
      projectId: second.output.id,
      subjectProductId: null,
      trade: "landscaping",
    });
  });

  it("preserves project settings on detach and refuses removing a required default", async () => {
    const parent = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Site parent",
        locations: ["Test site"],
        defaultTrade: "building",
      }),
      ctx.actor,
    );
    const child = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "Site child",
        parentProjectId: parent.output.id,
      }),
      ctx.actor,
    );
    expect(child.output).toMatchObject({
      locations: ["Test site"],
      defaultTrade: "building",
      fieldResolutions: { locations: { mode: "inherit" } },
    });
    const task = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Dependent task",
        projectId: child.output.id,
      }),
      ctx.actor,
    );
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
    expect(await getProjectByID(ctx.db, child.entityId)).toMatchObject({
      locations: ["Test site"],
      defaultTrade: "building",
      fieldResolutions: {
        defaultTrade: { mode: "explicit", matchesFallback: false },
      },
    });
    expect(
      await getTaskByShortcode(
        ctx.db,
        parseShortcodeFor("task", task.output.id),
      ),
    ).toMatchObject({ trade: "building" });
  });
});
