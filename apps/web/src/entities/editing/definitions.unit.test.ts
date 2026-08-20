import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";
import { entityEditRegistry } from "./definitions";
import { buildEntityEdit, resolveEntityEdit } from "./kernel";
import type { EditableEntity, EntityEditIntentDefinition } from "./types";

const editableEntities = allEntities.filter(
  (entity): entity is EditableEntity =>
    entity !== "image" && entity !== "usda-food" && entity !== "cookbook",
);

describe("entity edit definitions", () => {
  it("covers every standard editable entity exactly once", () => {
    expect(Object.keys(entityEditRegistry).sort()).toEqual(
      [...editableEntities].sort(),
    );
  });

  it("keeps semantic intent field selections local, valid, and non-empty", () => {
    for (const [entity, definition] of Object.entries(entityEditRegistry)) {
      const fieldIds = definition.fields.map((field) => field.id);
      expect(new Set(fieldIds).size, `${entity} field ids`).toBe(
        fieldIds.length,
      );
      expect(
        definition.invalidationKeys.length,
        `${entity} invalidation`,
      ).toBeGreaterThan(0);
      expect(definition.operations.create, `${entity} create`).toBeDefined();
      expect(definition.operations.update, `${entity} update`).toBeDefined();
      expect(definition.operations.delete, `${entity} delete`).toBeDefined();

      for (const [operation, declaration] of Object.entries(
        definition.operations,
      )) {
        expect(declaration, `${entity} ${operation}`).toBeDefined();
        if (!declaration) continue;
        expect(declaration.intents[declaration.defaultIntent]).toBeDefined();
        for (const [intent, capability] of Object.entries(
          declaration.intents,
        ) as Array<
          [string, EntityEditIntentDefinition<EditableEntity, never>]
        >) {
          if (operation !== "delete") {
            expect(
              capability.fields.length,
              `${entity} ${operation}/${intent}`,
            ).toBeGreaterThan(0);
          }
          for (const fieldId of capability.fields) {
            expect(
              fieldIds,
              `${entity} ${operation}/${intent} field`,
            ).toContain(fieldId);
          }
        }
      }
    }
  });

  it("declares delete availability wherever the schema declares a lifecycle", () => {
    for (const entity of editableEntities) {
      const definition = entityEditRegistry[entity];
      const deletion = entityManifest[entity].lifecycle.delete;
      expect(definition.operations.delete).toBeDefined();
      expect(deletion).not.toBeNull();
    }
  });

  it("keeps the calendar's semantic rules out of its presentation adapter", () => {
    const task = resolveEntityEdit(entityEditRegistry, {
      entity: "task",
      operation: "update",
      intent: "schedule",
      surface: "calendar",
      record: { id: "TSK-TEST" },
    });
    if (!("definition" in task)) throw new Error("task schedule must resolve");
    expect(
      buildEntityEdit(
        task,
        {
          entity: "task",
          operation: "update",
          intent: "schedule",
          surface: "calendar",
          record: { id: "TSK-TEST" },
        },
        {
          name: "Laundry",
          status: "not_started",
          dueDate: "2026-08-20",
          dueEndDate: "2026-08-19",
        },
      ),
    ).toMatchObject({ ok: false, issues: [{ field: "dueEndDate" }] });

    const actualExpense = resolveEntityEdit(entityEditRegistry, {
      entity: "expense",
      operation: "update",
      intent: "planned",
      surface: "calendar",
      record: { id: "EXP-TEST", future: false },
    });
    if (!("definition" in actualExpense)) {
      throw new Error("planned expense must resolve");
    }
    expect(
      buildEntityEdit(
        actualExpense,
        {
          entity: "expense",
          operation: "update",
          intent: "planned",
          surface: "calendar",
          record: { id: "EXP-TEST", future: false },
        },
        { name: "Receipt", cost: 12, date: "2026-08-20" },
      ),
    ).toMatchObject({ ok: false, issues: [{ source: "client" }] });
  });
});
