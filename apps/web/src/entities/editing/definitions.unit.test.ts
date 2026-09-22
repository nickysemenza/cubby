import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { EXPENSE_DATE_REQUIRED_MESSAGE } from "@cubby/schemas/expense-fields";
import { productWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { projectOut, taskOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
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
    entity !== "image" &&
    entity !== "usda-food" &&
    entity !== "cookbook" &&
    entity !== "importRun",
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

  // `changed` is computed from the post-`buildData` patch (not the raw
  // pre-`buildData` dirty-field patch) precisely so a `buildData` that
  // injects a fixed key can make an otherwise-untouched edit submit — the
  // mechanism `expense`'s `settle` intent relies on for a no-touch "Mark
  // purchased" (`future: false` is unconditional in its `buildData`).
  it("submits an otherwise-empty edit when buildData injects a fixed key (kernel)", () => {
    const today = householdLocalDate();
    // A minimal record — only the settle roster's own keys — rather than a
    // full `mock(expenseOut)`; this kernel-level test has no use for the rest.
    const record = {
      id: testShortcode("expense", "EXP-TEST"),
      lineKind: "principal",
      future: true,
      cost: 1000,
      date: today,
      costType: "materials",
      trade: null,
      notes: null,
      vendor: null,
      orderId: null,
      projectId: null,
    };
    const request = {
      entity: "expense" as const,
      operation: "update" as const,
      intent: "settle" as const,
      surface: "dialog" as const,
      record,
    };
    const resolved = resolveEntityEdit(entityEditRegistry, request);
    if (!("definition" in resolved))
      throw new Error("expense settle must resolve");
    // Every seeded value matches the record: an untouched dialog.
    const values = initialEntityEditValues(resolved, request);
    const result = buildEntityEdit(resolved, request, values);
    if (!result.ok || result.command.operation !== "update") {
      throw new Error("settle must build an update");
    }
    expect(result.changed).toBe(true);
    expect(result.command.data).toMatchObject({ future: false });
    // Only the injected key reached the wire — every rendered field was
    // genuinely untouched.
    expect(Object.keys(result.command.data)).toEqual(["future"]);
  });

  // A product's read projection nests `Date`s inside its `unitMappings` rows
  // (`unitMappingOut.createdAt`), which the value bag's `z.json()` branch
  // rejects: opening the editor threw. `unitMappings`' `FieldOptions.initial`
  // (`productUnitMappingsInitial`) projects each row to its input shape
  // (`{id,a,b,source}`) before the Date ever reaches the form, and an
  // untouched edit stays a no-op — in particular the write-only `upc`
  // (`readKey: null`, seeded `null`) must not reach the wire as `upc: null`,
  // which `syncPrimaryGtin` would read as "retire the primary GTIN".
  it("opens a record with nested Dates and keeps an untouched edit empty, write-only fields included", () => {
    const record = mock(productWithMappingsAndFoodOut, {
      seed: 5,
      overrides: {
        images: [],
        notes: "Keep dry",
        unitMappings: [
          {
            id: "6b1c2c1e-0000-4000-8000-000000000001",
            a: { value: 8, unit: "oz" },
            b: { value: 1, unit: "each" },
            source: "manual",
            sourceMetadata: { type: "manual" as const },
            createdAt: new Date("2026-01-02T03:04:05.000Z"),
            updatedAt: new Date("2026-01-02T03:04:05.000Z"),
          },
        ],
      },
    });
    const request = {
      entity: "product" as const,
      operation: "update" as const,
      intent: "full" as const,
      surface: "dialog" as const,
      record,
    };
    const resolved = resolveEntityEdit(entityEditRegistry, request);
    if (!("definition" in resolved)) throw new Error("product must resolve");
    const values = initialEntityEditValues(resolved, request);
    expect(values.unitMappings).toEqual([
      {
        id: "6b1c2c1e-0000-4000-8000-000000000001",
        a: { value: 8, unit: "oz" },
        b: { value: 1, unit: "each" },
        source: "manual",
      },
    ]);
    expect(values.upc).toBeNull();
    const untouched = buildEntityEdit(resolved, request, values);
    expect(untouched).toMatchObject({ ok: true, changed: false });
    if (!untouched.ok || untouched.command.operation !== "update")
      throw new Error("untouched edit must build an update");
    expect(untouched.command.data).toEqual({});

    // An explicitly cleared nullable *read* field is a real change.
    const cleared = buildEntityEdit(resolved, request, {
      ...values,
      notes: null,
    });
    expect(cleared).toMatchObject({ ok: true, changed: true });
    if (!cleared.ok || cleared.command.operation !== "update")
      throw new Error("cleared edit must build an update");
    expect(cleared.command.data).toEqual({ notes: null });
  });

  it("still emits null for a nullable read field cleared against a partial record", () => {
    const request = {
      entity: "expense" as const,
      operation: "update" as const,
      intent: "settle" as const,
      surface: "dialog" as const,
      // `notes` absent: an incomplete projection, not "nothing stored".
      record: {
        id: testShortcode("expense", "EXP-TEST"),
        future: true,
        cost: 12,
        date: "2026-08-20",
        costType: "materials",
        trade: null,
        vendor: null,
        orderId: null,
        projectId: null,
      },
    };
    const resolved = resolveEntityEdit(entityEditRegistry, request);
    if (!("definition" in resolved)) throw new Error("expense must resolve");
    const values = initialEntityEditValues(resolved, request);
    const result = buildEntityEdit(resolved, request, {
      ...values,
      notes: null,
    });
    expect(result).toMatchObject({
      ok: true,
      command: { operation: "update", data: { notes: null } },
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
      issues: [{ field: "date", message: EXPENSE_DATE_REQUIRED_MESSAGE }],
    });
  });
});
