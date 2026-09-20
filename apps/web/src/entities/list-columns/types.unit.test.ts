import { describe, expect, it } from "vitest";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";

import { assertSpecialistColumnProvenance } from "./types";

type Row = { id: string; name: string };
const helper = createCubbyColumnHelper<Row>();

function declaredColumns() {
  return createCubbyColumnCollection<Row>((add) => {
    add(helper.accessor("name", { id: "name" }));
  });
}

describe("assertSpecialistColumnProvenance", () => {
  it("rejects a new specialist column that silently omits provenance", () => {
    const declared = declaredColumns();
    const composed = createCubbyColumnCollection<Row>((add) => {
      declared.visit(add);
      add(helper.display({ id: "score", cell: () => "42" }));
    });

    expect(() =>
      assertSpecialistColumnProvenance("product", declared, composed),
    ).toThrow(
      "product.score is a specialist list column without explicit provenance",
    );
  });

  it("accepts explicit ordinary-field opt-outs", () => {
    const declared = declaredColumns();
    const composed = createCubbyColumnCollection<Row>((add) => {
      declared.visit(add);
      add(
        helper.display({
          id: "actions",
          meta: { provenance: null },
          cell: () => "Actions",
        }),
      );
    });

    expect(
      assertSpecialistColumnProvenance("product", declared, composed),
    ).toBe(composed);
  });
});
