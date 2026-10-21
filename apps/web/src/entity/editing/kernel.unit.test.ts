import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  EntityEditValue,
  EntityEditValueBag,
} from "~/entity/editing/value-schema";

import { collectionEditSchema } from "./collection-edit";
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

describe("ordinary identifier submission", () => {
  const saved = {
    source: "amazon",
    kind: "asin",
    externalId: "B0EXAMP001",
    url: "https://www.amazon.com/dp/B0EXAMP001",
    isPrimary: false,
  };
  const request = {
    entity: "product",
    operation: "update",
    surface: "dialog",
    intent: "full",
    fieldScope: "externalIds",
    record: { id: "PRD-2345", externalIds: [saved] },
  } as const;
  const resolve = () => {
    const resolved = resolveEntityEdit(entityEditRegistry, request);
    if (!isResolvedEntityEdit(resolved))
      throw new Error("Missing Product edit definition");
    return resolved;
  };

  it("normalizes local promotion before Product input validation and sends stored expectations", () => {
    const resolved = resolve();
    const values = initialEntityEditValues(resolved, request);
    expect(buildEntityEdit(resolved, request, values)).toMatchObject({
      ok: true,
      changed: false,
      command: { data: {} },
    });
    const local = collectionEditSchema.parse(values.externalIds);
    const row = local.collectionEdit.rows[0];
    if (!row) throw new Error("Missing saved row");
    row.primaryIntent = true;
    expect(
      buildEntityEdit(resolved, request, { externalIds: local }),
    ).toMatchObject({
      ok: true,
      command: {
        data: {
          externalIds: [
            {
              op: "replace",
              key: { source: "amazon", kind: "asin", externalId: "B0EXAMP001" },
              value: { isPrimary: true },
              expect: { url: null, isPrimary: false },
            },
          ],
        },
      },
    });
  });

  it("refuses a full-array update seed and a create-mode wrapper on update", () => {
    const resolved = resolve();
    expect(
      buildEntityEdit(resolved, request, { externalIds: [saved] }),
    ).toMatchObject({ ok: false, issues: [{ field: "externalIds" }] });
    const values = initialEntityEditValues(resolved, request);
    const local = collectionEditSchema.parse(values.externalIds);
    local.collectionEdit.creating = true;
    expect(
      buildEntityEdit(resolved, request, { externalIds: local }),
    ).toMatchObject({ ok: false, issues: [{ field: "externalIds" }] });
  });

  it("reports normalized-key collisions as field errors and preserves the local draft", () => {
    const resolved = resolve();
    const local = collectionEditSchema.parse(
      initialEntityEditValues(resolved, request).externalIds,
    );
    local.collectionEdit.rows.push({
      localKey: "new",
      baseline: null,
      value: { ...saved, source: " AMAZON " },
      primaryIntent: false,
      replacing: false,
    });
    expect(
      buildEntityEdit(resolved, request, { externalIds: local }),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          field: "externalIds",
          message: expect.stringContaining("already exists"),
        },
      ],
    });
    expect(local.collectionEdit.rows).toHaveLength(2);
  });

  it("preserves literal identity keys when replacing a manufacturer part", () => {
    const requestWithLiteral = {
      ...request,
      record: {
        id: "PRD-2345",
        externalIds: [
          {
            source: "sample",
            kind: "manufacturer_part",
            externalId: " part-A ",
            isPrimary: true,
            url: null,
          },
        ],
      },
    };
    const resolved = resolveEntityEdit(entityEditRegistry, requestWithLiteral);
    if (!isResolvedEntityEdit(resolved))
      throw new Error("Missing Product editor");
    const local = collectionEditSchema.parse(
      initialEntityEditValues(resolved, requestWithLiteral).externalIds,
    );
    const row = local.collectionEdit.rows[0];
    if (!row?.value) throw new Error("Missing literal saved row");
    row.value.externalId = "PART-A";
    expect(
      buildEntityEdit(resolved, requestWithLiteral, { externalIds: local }),
    ).toMatchObject({
      ok: true,
      command: {
        data: {
          externalIds: [
            { op: "remove", key: { externalId: " part-A " } },
            { op: "add", key: { externalId: "PART-A" } },
          ],
        },
      },
    });
  });
});

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

  it("applies an update seed too, since one only exists when a caller sent it (V7)", () => {
    const request = {
      entity: "task" as const,
      operation: "update" as const,
      surface: "calendar" as const,
      record: { id: "TSK-1", name: "saved" },
      seed: { name: "seed value" },
    };
    const resolved = resolveEntityEdit(registry, request);
    expect(isResolvedEntityEdit(resolved)).toBe(true);
    if (!isResolvedEntityEdit(resolved)) return;
    expect(initialEntityEditValues(resolved, request)).toEqual({
      name: "seed value",
    });
  });

  it("leaves an update's saved values alone when no seed is supplied", () => {
    const request = {
      entity: "task" as const,
      operation: "update" as const,
      surface: "calendar" as const,
      record: { id: "TSK-1", name: "saved" },
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
