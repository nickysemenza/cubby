import { financialAccountOut } from "@cubby/schemas/entities/financialAccount";
import { projectOut } from "@cubby/schemas/entities/project";
import { taskOut } from "@cubby/schemas/entities/task";
import { EXPENSE_DATE_REQUIRED_MESSAGE } from "@cubby/schemas/expense-fields";
import { productWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createEditorTestQueryClient } from "#web/tests/editor-metadata.fixtures.ts";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { generatedEditableEntities } from "~/entity/generated/entity-edit-validation-types.gen";
import { householdLocalDate } from "~/lib/household-date";
import { mock } from "~/lib/test/mock-schema";

import { getEntityEditDefinition } from "./definitions";
import {
  buildEntityEdit,
  initialEntityEditValues,
  resolveEntityEdit,
} from "./kernel";
import type { EditableEntity } from "./types";

const queryClient = createEditorTestQueryClient();

const explicitNoneResolution = () => ({
  current: {
    assignment: { kind: "none" },
    controls: {
      kind: "editable",
      canSetNone: true,
      canConfirm: false,
      reset: {
        kind: "available",
        preview: {
          kind: "ready",
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "empty", reason: "unset" },
              provenance: null,
            },
          },
        },
      },
    },
  },
  result: {
    kind: "live",
    decision: {
      outcome: { kind: "empty", reason: "explicit_none" },
      provenance: { kind: "own", ownership: { kind: "record" } },
    },
  },
  work: { kind: "idle" },
});

describe("entity edit definitions", () => {
  it("edits a card scalar without resending its identity siblings", async () => {
    const record = mock(financialAccountOut, {
      overrides: {
        identity: {
          kind: "credit_card",

          network: "visa",
        },
        fields: {
          providerVendorId: fieldValueFixture(
            financialAccountOut.shape.fields.shape.providerVendorId,
            testShortcode("vendor", "BANK"),
          ),
          network: fieldValueFixture(
            financialAccountOut.shape.fields.shape.network,
            "visa",
          ),
        },
      },
    });
    const request = {
      entity: "financialAccount",
      operation: "update",
      intent: "full",
      surface: "dialog",
      record,
    } as const;
    const resolved = resolveEntityEdit(queryClient, request);
    if (!("definition" in resolved))
      throw new Error("Account editor must resolve");
    const values = initialEntityEditValues(resolved, request);
    const result = await buildEntityEdit(resolved, request, {
      ...values,
      providerVendorId: testShortcode("vendor", "UNION"),
    });
    if (!result.ok || !result.changed || result.command.operation !== "update")
      throw new Error("Card scalar edit must build an update");
    expect(result.command.data).toEqual({
      providerVendorId: testShortcode("vendor", "UNION"),
    });
  });
  it.each(["task", "expense"] as const)(
    "leaves %s capture trade unresolved until chosen or inherited",
    async (entity) => {
      const request = {
        entity,
        operation: "create" as const,
        intent: "capture" as const,
        surface: "dialog" as const,
      };
      const resolved = resolveEntityEdit(queryClient, request);
      if (!("definition" in resolved)) throw new Error("Capture must resolve");
      const values = initialEntityEditValues(resolved, request);
      const result = await buildEntityEdit(resolved, request, {
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
    async ({ entity, modes, resolutionField }) => {
      const createRequest = {
        entity,
        operation: "create" as const,
        intent: "full" as const,
        surface: "dialog" as const,
      };
      const createResolved = resolveEntityEdit(queryClient, createRequest);
      if (!("definition" in createResolved))
        throw new Error("Create must resolve");
      const createValues = initialEntityEditValues(
        createResolved,
        createRequest,
      );
      for (const mode of modes) expect(createValues[mode]).toBe("inherit");
      expect(
        (
          await buildEntityEdit(createResolved, createRequest, {
            ...createValues,
            name: "Synthetic work",
          })
        ).ok,
      ).toBe(true);

      const record = {
        ...(entity === "task" ? mock(taskOut) : mock(projectOut)),
        name: "Synthetic work",
        images: [],
        fields: { [resolutionField]: explicitNoneResolution() },
      };
      const updateRequest = {
        entity,
        operation: "update" as const,
        intent: "full" as const,
        surface: "dialog" as const,
        record,
      };
      const resolved = resolveEntityEdit(queryClient, updateRequest);
      if (!("definition" in resolved)) throw new Error("Update must resolve");
      const values = initialEntityEditValues(resolved, updateRequest);
      expect(values[modes[0]!]).toBe("explicit");
      // An unrelated edit must not emit a hidden mode and suppress the server's
      // detach-preservation behavior.
      const result = await buildEntityEdit(resolved, updateRequest, {
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

  it("keeps semantic intent field selections local, valid, and non-empty", async () => {
    for (const entity of generatedEditableEntities) {
      const definition = getEntityEditDefinition(queryClient, entity);
      const fieldIds = definition.fields.map((field) => field.id);
      expect(new Set(fieldIds).size, `${entity} field ids`).toBe(
        fieldIds.length,
      );
      expect(definition.operations.update, `${entity} update`).toBeDefined();
      expect(definition.operations.delete, `${entity} delete`).toBeDefined();

      for (const operation of ["create", "update", "delete"] as const) {
        const declaration = definition.operations[operation];
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

  it("keeps the full update intent compatible with ordinary inline editors", async () => {
    const inlineFields: readonly [EditableEntity, readonly string[]][] = [
      ["product", ["ingredientId", "barcode", "fdc_id", "unitMappings"]],
      [
        "expense",
        ["lineKind", "lineBasis", "productQuantity", "orderId", "url"],
      ],
      [
        "project",
        [
          "costEstimate",
          "emoji",
          "locations",
          "googleDriveFolderUrl",
          "notionPageUrl",
          "blockedByIds",
        ],
      ],
    ];

    for (const [entity, fields] of inlineFields) {
      const full = getEntityEditDefinition(queryClient, entity).operations
        .update?.intents.full;
      expect(full, `${entity} full update intent`).toBeDefined();
      for (const fieldId of fields) {
        expect(full?.fields, `${entity} inline field ${fieldId}`).toContain(
          fieldId,
        );
      }
    }
  });

  it("keeps finance update payloads minimal when replacement arrays are unchanged", async () => {
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
    const resolved = resolveEntityEdit(queryClient, request);
    if (!("definition" in resolved)) {
      throw new Error("financial transaction full update must resolve");
    }

    expect(
      await buildEntityEdit(resolved, request, {
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

  // A claim's read carries `sourceKey` (its identity hash) and audit stamps, never the
  // `providerId` it was made from. The form holds the read clipped to the input schema, so an
  // untouched claim is not a patch and an edited one goes back under the identity it was read
  // with instead of being rehashed from its evidence.
  it("edits a source claim under the identity key it was read with", async () => {
    const claim = {
      source: "synthetic-provider",
      normalizedEvidence: {
        amount: 10,
        occurredOn: "2026-08-20",
        description: null,
        context: null,
        disambiguator: null,
      },
      reconciliation: { decision: "amounts_match" as const },
      sourceKey: `v1:${"0".repeat(64)}`,
      sourceKeyVersion: 1,
      targetAmountAtClaim: 10,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const record = {
      id: testShortcode("ledgerTransfer", "LTR-TEST"),
      fromPartyId: testShortcode("ledgerParty", "LPY-FROM"),
      toPartyId: testShortcode("ledgerParty", "LPY-TO"),
      amount: 10,
      date: "2026-08-20",
      notes: null,
      sourceClaims: [claim],
    };
    const request = {
      entity: "ledgerTransfer" as const,
      operation: "update" as const,
      intent: "full" as const,
      surface: "dialog" as const,
      record,
    };
    const resolved = resolveEntityEdit(queryClient, request);
    if (!("definition" in resolved)) throw new Error("transfer must resolve");
    const values = initialEntityEditValues(resolved, request);

    const untouched = await buildEntityEdit(resolved, request, values);
    if (!untouched.ok) throw new Error(JSON.stringify(untouched.issues));
    expect(untouched).toMatchObject({ ok: true, changed: false });
    const [held] = z
      .array(z.record(z.string(), z.json()))
      .parse(values.sourceClaims);
    expect(held).toMatchObject({ sourceKey: claim.sourceKey });
    expect(held).not.toHaveProperty("sourceKeyVersion");

    const reviewed = await buildEntityEdit(resolved, request, {
      ...values,
      sourceClaims: [
        {
          ...held,
          reconciliation: {
            decision: "accept_target_amount",
            note: "Reviewed",
          },
        },
      ],
    });
    if (!reviewed.ok || !reviewed.changed)
      throw new Error("must build a patch");
    expect(reviewed.command).toMatchObject({
      data: {
        sourceClaims: [
          {
            sourceKey: claim.sourceKey,
            reconciliation: { decision: "accept_target_amount" },
          },
        ],
      },
    });
  });

  // `changed` is computed from the post-`buildData` patch (not the raw
  // pre-`buildData` dirty-field patch) precisely so a `buildData` that
  // injects a fixed key can make an otherwise-untouched edit submit — the
  // mechanism `expense`'s `settle` intent relies on for a no-touch "Mark
  // purchased" (`future: false` is unconditional in its `buildData`).
  it("submits an otherwise-empty edit when buildData injects a fixed key (kernel)", async () => {
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
    const resolved = resolveEntityEdit(queryClient, request);
    if (!("definition" in resolved))
      throw new Error("expense settle must resolve");
    // Every seeded value matches the record: an untouched dialog.
    const values = initialEntityEditValues(resolved, request);
    const result = await buildEntityEdit(resolved, request, values);
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
  // untouched edit stays a no-op — in particular the create/provider `barcode`
  // shortcut has no independent ordinary-update draft and must not reach the wire as `barcode: null`,
  // which the collection writer would read as "retire the primary GTIN".
  it.each([
    {
      servingGrams: 30,
      source: "Synthetic prior label",
      nutrients: { kcal: 90, fat: 0 },
    },
    {
      servingGrams: 30,
      source: "Synthetic prior label",
      nutrients: { kcal: 90 },
      inferredZeroNutrients: ["fat" as const],
      inferenceEvidence: "Not a significant source of total fat.",
    },
  ])(
    "opens a record with nested Dates and keeps untouched nutrition and write-only fields empty",
    async (labelNutrition) => {
      const record = mock(productWithMappingsAndFoodOut, {
        seed: 5,
        overrides: {
          notes: "Keep dry",
          labelNutrition,
          fields: {
            tags: {
              current: {
                assignment: {
                  kind: "value",
                  value: [],
                  ownership: { kind: "record" },
                },
              },
            },
          },
          externalIds: [],
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
      const resolved = resolveEntityEdit(queryClient, request);
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
      expect(values.barcode).toBeUndefined();
      const untouched = await buildEntityEdit(resolved, request, values);
      expect(untouched.ok ? [] : untouched.issues).toEqual([]);
      expect(untouched).toMatchObject({ ok: true, changed: false });
      if (!untouched.ok || untouched.command.operation !== "update")
        throw new Error("untouched edit must build an update");
      expect(untouched.command.data).toEqual({});

      // An explicitly cleared nullable *read* field is a real change.
      const cleared = await buildEntityEdit(resolved, request, {
        ...values,
        notes: null,
      });
      expect(cleared).toMatchObject({ ok: true, changed: true });
      if (!cleared.ok || cleared.command.operation !== "update")
        throw new Error("cleared edit must build an update");
      expect(cleared.command.data).toEqual({ notes: null });

      const clearedLabel = await buildEntityEdit(resolved, request, {
        ...values,
        labelNutrition: { servingGrams: null },
      });
      expect(clearedLabel).toMatchObject({ ok: true, changed: true });
      if (!clearedLabel.ok || clearedLabel.command.operation !== "update")
        throw new Error("cleared label must build an update");
      expect(clearedLabel.command.data).toEqual({ labelNutrition: null });
    },
  );

  it("still emits null for a nullable read field cleared against a partial record", async () => {
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
    const resolved = resolveEntityEdit(queryClient, request);
    if (!("definition" in resolved)) throw new Error("expense must resolve");
    const values = initialEntityEditValues(resolved, request);
    const result = await buildEntityEdit(resolved, request, {
      ...values,
      notes: null,
    });
    expect(result).toMatchObject({
      ok: true,
      command: { operation: "update", data: { notes: null } },
    });
  });

  it("defaults pendingImageIds to an empty array off the field roster, not a per-entity literal (G5)", async () => {
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
      const resolved = resolveEntityEdit(queryClient, request);
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

  it("keeps the calendar's semantic rules out of its presentation adapter", async () => {
    const task = resolveEntityEdit(queryClient, {
      entity: "task",
      operation: "update",
      intent: "schedule",
      surface: "calendar",
      record: { id: "TSK-TEST" },
    });
    if (!("definition" in task)) throw new Error("task schedule must resolve");
    expect(
      await buildEntityEdit(
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
          due: { start: "2026-08-20", end: "2026-08-19" },
        },
      ),
    ).toMatchObject({ ok: false, issues: [{ field: "due" }] });

    expect(
      await buildEntityEdit(
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
          due: null,
        },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "due", message: "This field is required." }],
    });

    const actualExpense = resolveEntityEdit(queryClient, {
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
      await buildEntityEdit(
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

    const plannedExpense = resolveEntityEdit(queryClient, {
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
      await buildEntityEdit(
        plannedExpense,
        {
          entity: "expense",
          operation: "update",
          intent: "planned",
          surface: "calendar",
          record: { id: "EXP-PLANNED", future: true },
        },
        { name: "Upcoming", cost: 12, date: null },
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "date", message: EXPENSE_DATE_REQUIRED_MESSAGE }],
    });
    // Unknown cost (a historical acquisition) may keep an unknown date.
    expect(
      await buildEntityEdit(
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
    ).toMatchObject({ ok: true });
  });
});
