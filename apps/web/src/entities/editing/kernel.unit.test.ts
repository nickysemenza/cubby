import { describe, expect, it } from "vitest";
import {
  buildEntityEdit,
  createFakeEntityMutationPort,
  executeEntityEdit,
  initialEntityEditValues,
  isResolvedEntityEdit,
  resolveEntityEdit,
} from "./kernel";
import type { EntityEditRegistry } from "./registry";
import type {
  EntityEditContext,
  EntityEditField,
  EntityEditRecord,
} from "./types";

const editable = { mode: "editable" } as const;

const nameField: EntityEditField<"task", EntityEditRecord, string, object> = {
  entity: "task",
  id: "name",
  access: () => editable,
  initial: ({ record }) =>
    (record as { name?: string } | undefined)?.name ?? "field default",
  normalize: (value) => value.trim(),
  validate: ({ value }) =>
    value
      ? []
      : [{ field: "name", message: "Name is required.", source: "client" }],
  toPatch: ({ value, record }) =>
    (record as { name?: string } | undefined)?.name === value
      ? undefined
      : { name: value },
};

const registry = {
  task: {
    entity: "task",
    fields: [nameField],
    invalidationKeys: [["task"]],
    operations: {
      create: {
        defaultIntent: "capture",
        intents: {
          capture: {
            fields: ["name"],
            defaults: { name: "intent default" },
            access: () => editable,
            build: ({
              patch,
            }: {
              record?: EntityEditRecord;
              patch: object;
              context: EntityEditContext;
            }) => ({
              ok: true as const,
              changed: true,
              command: {
                entity: "task" as const,
                operation: "create" as const,
                intent: "capture",
                data: patch,
              },
            }),
          },
        },
      },
      update: {
        defaultIntent: "schedule",
        intents: {
          schedule: {
            fields: ["name"],
            access: () => editable,
            build: ({
              record,
              patch,
            }: {
              record?: EntityEditRecord;
              patch: object;
              context: EntityEditContext;
            }) => ({
              ok: true as const,
              changed: Object.keys(patch).length > 0,
              command: {
                entity: "task" as const,
                operation: "update" as const,
                intent: "schedule",
                id: record?.id,
                data: patch,
              },
            }),
          },
        },
      },
    },
  },
} as unknown as EntityEditRegistry;

describe("entity editing kernel", () => {
  it("applies field, intent, then create-seed defaults", () => {
    const request = {
      entity: "task" as const,
      operation: "create" as const,
      surface: "calendar" as const,
      seed: { name: "seed value" },
    };
    const resolved = resolveEntityEdit(registry, request);
    expect(isResolvedEntityEdit(resolved)).toBe(true);
    if (!isResolvedEntityEdit(resolved)) return;
    expect(initialEntityEditValues(resolved, request)).toEqual({
      name: "seed value",
    });
  });

  it("does not silently apply an update seed", () => {
    const request = {
      entity: "task" as const,
      operation: "update" as const,
      surface: "calendar" as const,
      record: { id: "TSK-1", name: "saved" },
      seed: { name: "must not leak" },
    };
    const resolved = resolveEntityEdit(registry, request);
    expect(isResolvedEntityEdit(resolved)).toBe(true);
    if (!isResolvedEntityEdit(resolved)) return;
    expect(initialEntityEditValues(resolved, request)).toEqual({
      name: "saved",
    });
  });

  it("normalizes, validates, and omits unchanged patches", () => {
    const request = {
      entity: "task" as const,
      operation: "update" as const,
      surface: "calendar" as const,
      record: { id: "TSK-1", name: "saved" },
    };
    const resolved = resolveEntityEdit(registry, request);
    if (!isResolvedEntityEdit(resolved)) throw new Error("expected definition");

    expect(
      buildEntityEdit(resolved, request, { name: " saved " }),
    ).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(buildEntityEdit(resolved, request, { name: " " })).toEqual({
      ok: false,
      issues: [
        { field: "name", message: "Name is required.", source: "client" },
      ],
    });
  });

  it("executes once, invalidates canonical keys, and records background work", async () => {
    const request = {
      entity: "task" as const,
      operation: "create" as const,
      surface: "calendar" as const,
    };
    const resolved = resolveEntityEdit(registry, request);
    if (!isResolvedEntityEdit(resolved)) throw new Error("expected definition");
    const build = buildEntityEdit(resolved, request, { name: "new task" });
    const fake = createFakeEntityMutationPort();
    const result = await executeEntityEdit(
      fake.port,
      resolved.definition,
      build,
    );

    expect(result).toMatchObject({ ok: true, id: "created", changed: true });
    expect(fake.commands).toHaveLength(1);
    expect(fake.invalidations).toEqual([[["task"]]]);
    expect(fake.backgroundWork).toHaveLength(1);
  });
});
