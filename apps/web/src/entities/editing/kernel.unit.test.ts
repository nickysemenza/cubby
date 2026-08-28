import { describe, expect, it } from "vitest";
import { z } from "zod";

import { entityEditRegistry } from "./definitions";
import {
  buildEntityEdit,
  initialEntityEditValues,
  isResolvedEntityEdit,
  resolveEntityEdit,
} from "./kernel";
import {
  parseEntityEditCreateInput,
  parseEntityEditUpdateInput,
} from "./mutation-data";
import type { EntityEditRegistry } from "./registry";
import type {
  EntityEditDefinition,
  EntityEditField,
  EntityEditRecord,
  EntityEditValue,
  EntityEditValueBag,
} from "./types";

const editable = { mode: "editable" } as const;

const stringValue = (value: EntityEditValue): string => z.string().parse(value);
const savedName = (record: EntityEditRecord | undefined): string | undefined =>
  z.string().safeParse(record?.name).data;

const nameField: EntityEditField<
  "task",
  EntityEditRecord,
  EntityEditValue,
  EntityEditValueBag
> = {
  entity: "task",
  id: "name",
  access: () => editable,
  initial: ({ record }) => savedName(record) ?? "field default",
  normalize: (value) => stringValue(value).trim(),
  validate: ({ value }) =>
    stringValue(value)
      ? []
      : [{ field: "name", message: "Name is required.", source: "client" }],
  toPatch: ({ value, record }) =>
    savedName(record) === value ? undefined : { name: value },
};

const taskDefinition = {
  entity: "task",
  fields: [nameField],
  operations: {
    create: {
      defaultIntent: "capture",
      intents: {
        capture: {
          fields: ["name"],
          defaults: { name: "intent default" },
          access: () => editable,
          build: ({ patch }) => ({
            ok: true as const,
            changed: true,
            command: {
              entity: "task",
              operation: "create",
              intent: "capture",
              data: parseEntityEditCreateInput("task", patch),
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
          build: ({ record, patch }) =>
            record
              ? {
                  ok: true as const,
                  changed: Object.keys(patch).length > 0,
                  command: {
                    entity: "task" as const,
                    operation: "update" as const,
                    intent: "schedule",
                    id: record.id,
                    data: parseEntityEditUpdateInput("task", patch),
                  },
                }
              : {
                  ok: false as const,
                  issues: [
                    {
                      message: "Saved task is required.",
                      source: "client" as const,
                    },
                  ],
                },
        },
      },
    },
  },
} satisfies EntityEditDefinition<"task", EntityEditRecord>;

const registry = {
  ...entityEditRegistry,
  task: taskDefinition,
} satisfies EntityEditRegistry;

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
});
