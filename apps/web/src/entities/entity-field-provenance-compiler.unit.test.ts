import { describe, expect, it } from "vitest";

import purchaseDeclaration from "../../../../packages/schemas/src/entity-definitions/12-purchase.entity";
import vendorAccountDeclaration from "../../../../packages/schemas/src/entity-definitions/21-vendorAccount.entity";
import {
  compileEntity,
  validateEntityIdentities,
} from "../../../../scripts/generator/entities/compile";

describe("entity field provenance", () => {
  it("publishes a reference field's related entity", () => {
    const compiled = compileEntity(purchaseDeclaration, 0);
    const vendor = compiled.fieldModel.fields.find(
      (field) => field.key === "vendorId",
    );

    expect(vendor?.provenance).toEqual({
      kind: "reference",
      sources: [{ entity: "vendor", label: null, relation: null }],
    });
  });

  it("publishes declared derived sources and their inspectable relation", () => {
    const declaration = {
      ...purchaseDeclaration,
      model: {
        ...purchaseDeclaration.model,
        fields: purchaseDeclaration.model.fields.map((field) =>
          field.key === "financialReconciliation"
            ? {
                ...field,
                provenance: {
                  kind: "derived" as const,
                  sources: [
                    {
                      entity: "financialTransaction",
                      relation: "financial-transactions",
                    },
                  ],
                },
              }
            : field,
        ),
      },
    };

    const compiled = compileEntity(declaration, 0);
    const settlement = compiled.fieldModel.fields.find(
      (field) => field.key === "financialReconciliation",
    );

    expect(settlement?.provenance).toEqual({
      kind: "derived",
      sources: [
        {
          entity: "financialTransaction",
          label: null,
          relation: "financial-transactions",
        },
      ],
    });
    expect(settlement?.control).toBeNull();
    expect(compiled.fieldModel.update).not.toContain("financialReconciliation");
  });

  it("rejects exposed storage-less fields without provenance", () => {
    const declaration = {
      ...vendorAccountDeclaration,
      model: {
        ...vendorAccountDeclaration.model,
        storage: vendorAccountDeclaration.model.storage.filter(
          (field) => field !== "lastRunAt",
        ),
      },
    };

    expect(() => compileEntity(declaration, 0)).toThrow(
      /model\.lastRunAt is exposed without storage, a reference, or declared provenance/u,
    );
  });

  it("rejects an inspectable source whose relation targets another entity", () => {
    const declaration = {
      ...purchaseDeclaration,
      model: {
        ...purchaseDeclaration.model,
        fields: purchaseDeclaration.model.fields.map((field) =>
          field.key === "financialReconciliation"
            ? {
                ...field,
                provenance: {
                  kind: "derived" as const,
                  sources: [
                    { entity: "expense", relation: "financial-transactions" },
                  ],
                },
              }
            : field,
        ),
      },
    };

    expect(() => compileEntity(declaration, 0)).toThrow(
      /relation financial-transactions targets financialTransaction, not expense/u,
    );
  });

  it("rejects provenance that names an undeclared entity", () => {
    const compiled = compileEntity(purchaseDeclaration, 0);
    const settlement = compiled.fieldModel.fields.find(
      (field) => field.key === "financialReconciliation",
    );
    if (!settlement) throw new Error("missing financial reconciliation field");
    const invalid = {
      ...compiled,
      fieldModel: {
        ...compiled.fieldModel,
        fields: [
          {
            ...settlement,
            provenance: {
              kind: "derived" as const,
              sources: [
                {
                  entity: "notAnEntity",
                  label: null,
                  relation: null,
                },
              ],
            },
          },
        ],
      },
    };

    expect(() => validateEntityIdentities([invalid])).toThrow(
      /provenance names undeclared entity notAnEntity/u,
    );
  });
});
