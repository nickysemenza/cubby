import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { projectOut, taskOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";

import { entityEditRegistry } from "./definitions";
import {
  buildEntityEdit,
  initialEntityEditValues,
  resolveEntityEdit,
} from "./kernel";
import type { EditableEntity } from "./types";

// `ledgerParty`/`ledgerTransfer` joined the registry when they gained browser
// routes: the shared action and command chrome is keyed by edit intent and runs
// for every routed entity, so they need entries even though no editor UI is
// rendered for them yet and their create/update still go through MCP.
const editableEntities = allEntities.filter(
  (entity): entity is EditableEntity =>
    entity !== "image" && entity !== "usda-food" && entity !== "cookbook",
);

// Proves the property `genericCreateDefault` (definitions.ts) relies on:
// Zod 4 exposes a `ZodDefault`'s default as a plain `def.defaultValue`
// property, not a function to call.
it("exposes a Zod 4 default as a plain def.defaultValue property", () => {
  const schema = z.string().default("cooked");
  expect(schema).toBeInstanceOf(z.ZodDefault);
  expect(schema.def.defaultValue).toBe("cooked");
});

const explicitNoneResolution = () => ({
  mode: "none" as const,
  storedValue: null,
  value: null,
  fallbackValue: null,
  source: "Explicit choice",
  sourceEntity: null,
  matchesFallback: false,
  canReset: true,
});

describe("entity edit definitions", () => {
  it.each(["task", "expense"] as const)(
    "leaves %s capture trade unresolved until chosen or inherited",
    (entity) => {
      const request = {
        entity,
        operation: "create" as const,
        intent: "capture" as const,
        surface: "dialog" as const,
      };
      const resolved = resolveEntityEdit(entityEditRegistry, request);
      if (!("definition" in resolved)) throw new Error("Capture must resolve");
      const values = initialEntityEditValues(resolved, request);
      const result = buildEntityEdit(resolved, request, {
        ...values,
        name: "Synthetic work",
      });
      if (
        !result.ok ||
        !result.changed ||
        result.command.operation !== "create"
      )
        throw new Error("Capture must build a create");
      expect(result.command.data.trade).toBeNull();
    },
  );
  it.each([
    {
      entity: "task" as const,
      modes: ["projectMode", "subjectProductMode"],
      resolutionField: "projectId",
    },
    {
      entity: "project" as const,
      modes: ["locationsMode"],
      resolutionField: "locations",
    },
  ])(
    "preserves $entity assignment intent through ordinary form saves",
    ({ entity, modes, resolutionField }) => {
      const createRequest = {
        entity,
        operation: "create" as const,
        intent: "full" as const,
        surface: "dialog" as const,
      };
      const createResolved = resolveEntityEdit(
        entityEditRegistry,
        createRequest,
      );
      if (!("definition" in createResolved))
        throw new Error("Create must resolve");
      const createValues = initialEntityEditValues(
        createResolved,
        createRequest,
      );
      for (const mode of modes) expect(createValues[mode]).toBe("inherit");
      expect(
        buildEntityEdit(createResolved, createRequest, {
          ...createValues,
          name: "Synthetic work",
        }).ok,
      ).toBe(true);

      const record = {
        ...(entity === "task" ? mock(taskOut) : mock(projectOut)),
        name: "Synthetic work",
        images: [],
        fieldResolutions: { [resolutionField]: explicitNoneResolution() },
      };
      const updateRequest = {
        entity,
        operation: "update" as const,
        intent: "full" as const,
        surface: "dialog" as const,
        record,
      };
      const resolved = resolveEntityEdit(entityEditRegistry, updateRequest);
      if (!("definition" in resolved)) throw new Error("Update must resolve");
      const values = initialEntityEditValues(resolved, updateRequest);
      expect(values[modes[0]!]).toBe("explicit");
      // An unrelated edit must not emit a hidden mode and suppress the server's
      // detach-preservation behavior.
      const result = buildEntityEdit(resolved, updateRequest, {
        ...values,
        name: "Renamed work",
      });
      if (
        !result.ok ||
        !result.changed ||
        result.command.operation !== "update"
      )
        throw new Error("Rename must build an update");
      expect(result.command.data).toHaveProperty("name", "Renamed work");
      for (const mode of modes)
        expect(result.command.data).not.toHaveProperty(mode);
    },
  );

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
      expect(definition.operations.create, `${entity} create`).toBeDefined();
      expect(definition.operations.update, `${entity} update`).toBeDefined();
      expect(definition.operations.delete, `${entity} delete`).toBeDefined();

      for (const operation of ["create", "update", "delete"] as const) {
        const declaration = definition.operations[operation];
        expect(declaration, `${entity} ${operation}`).toBeDefined();
        if (!declaration) continue;
        expect(declaration.intents[declaration.defaultIntent]).toBeDefined();
        for (const [intent, capability] of Object.entries(
          declaration.intents,
        )) {
          if (operation !== "delete") {
            // oxlint-disable-next-line vitest/no-conditional-expect -- The data-dependent branch determines whether this optional case is applicable.
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

  it("keeps the full update intent compatible with ordinary inline editors", () => {
    const inlineFields: readonly [EditableEntity, readonly string[]][] = [
      ["product", ["ingredientId", "upc", "fdc_id", "unitMappings"]],
      [
        "expense",
        ["lineKind", "lineBasis", "productQuantity", "orderId", "url"],
      ],
      [
        "project",
        [
          "costEstimate",
          "icon",
          "locations",
          "googleDriveFolderUrl",
          "notionPageUrl",
          "blockedByIds",
        ],
      ],
    ];

    for (const [entity, fields] of inlineFields) {
      const full = entityEditRegistry[entity].operations.update?.intents.full;
      expect(full, `${entity} full update intent`).toBeDefined();
      for (const fieldId of fields) {
        expect(full?.fields, `${entity} inline field ${fieldId}`).toContain(
          fieldId,
        );
      }
    }
  });

  it("keeps finance update payloads minimal when replacement arrays are unchanged", () => {
    const record = {
      id: "FTX-TEST",
      accountId: testShortcode("financialAccount", "FAC-TEST"),
      purchaseId: null,
      kind: "purchase" as const,
      status: "posted" as const,
      amount: 12,
      transactionDate: "2026-08-19",
      postedDate: "2026-08-20",
      merchant: "Old merchant",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [{ source: "statement", externalId: "row-1" }],
      notes: null,
    };
    const request = {
      entity: "financialTransaction" as const,
      operation: "update" as const,
      intent: "full" as const,
      surface: "dialog" as const,
      record,
    };
    const resolved = resolveEntityEdit(entityEditRegistry, request);
    if (!("definition" in resolved)) {
      throw new Error("financial transaction full update must resolve");
    }

    expect(
      buildEntityEdit(resolved, request, {
        ...record,
        merchant: "New merchant",
        sourceRefs: [{ source: "statement", externalId: "row-1" }],
      }),
    ).toMatchObject({
      ok: true,
      changed: true,
      command: { data: { merchant: "New merchant" } },
    });
  });

  it("defaults pendingImageIds to an empty array off the field roster, not a per-entity literal (G5)", () => {
    const cases = [
      ["gardenEntry", "full"],
      ["gardenEntry", "capture"],
      ["meal", "capture"],
      ["task", "capture"],
    ] as const;
    for (const [entity, intent] of cases) {
      const request = {
        entity,
        operation: "create" as const,
        intent,
        surface: "dialog" as const,
      };
      const resolved = resolveEntityEdit(entityEditRegistry, request);
      if (!("definition" in resolved)) {
        throw new Error(`${entity} ${intent} create must resolve`);
      }
      expect(
        resolved.intentDefinition.fields,
        `${entity} ${intent} roster`,
      ).toContain("pendingImageIds");
      expect(
        initialEntityEditValues(resolved, request).pendingImageIds,
        `${entity} pendingImageIds default`,
      ).toEqual([]);
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
          dueDate: null,
          dueEndDate: null,
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "dueDate", message: "Date is required" }],
    });

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

    const plannedExpense = resolveEntityEdit(entityEditRegistry, {
      entity: "expense",
      operation: "update",
      intent: "planned",
      surface: "calendar",
      record: { id: "EXP-PLANNED", future: true },
    });
    if (!("definition" in plannedExpense)) {
      throw new Error("planned expense must resolve");
    }
    expect(
      buildEntityEdit(
        plannedExpense,
        {
          entity: "expense",
          operation: "update",
          intent: "planned",
          surface: "calendar",
          record: { id: "EXP-PLANNED", future: true },
        },
        { name: "Upcoming", cost: null, date: null },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "date", message: "Date is required" }],
    });
  });
});
