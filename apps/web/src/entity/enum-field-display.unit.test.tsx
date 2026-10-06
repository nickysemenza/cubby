import { cleanup, render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it } from "vitest";

import { renderOptionCell } from "~/ui/data-table/columnHelpers";

import { financialAccountDetailFields } from "./detail-field-renderers/financial-account";
import { fieldEnumOptions } from "./enum-field-display";

afterEach(cleanup);

const pillFor = (label: string) => {
  const pill = screen.getByText(label).parentElement;
  if (!(pill instanceof HTMLElement))
    throw new Error(`Expected ${label} to render inside an enum pill`);
  return pill;
};

describe("declared value rosters (display.valueOptions)", () => {
  it("labels a JSON field's kind member instead of humanizing the enum literal", () => {
    // `stored_value` humanized reads "stored value"; the declared roster names it.
    render(
      financialAccountDetailFields["financial-account-identity"](
        fromPartial({ identity: { kind: "stored_value" } }),
      ).value,
    );

    expect(pillFor("Gift card or store credit")).toHaveStyle(
      "--enum-pill-color: var(--slate)",
    );
  });

  it("tones a derived status from the declaration", () => {
    render(
      renderOptionCell("acquired", fieldEnumOptions("wish", "acquiredAt")),
    );

    expect(pillFor("Acquired")).toHaveStyle(
      "--enum-pill-color: var(--positive)",
    );
  });

  // Capture attribution is server-derived; reproducing ambiguous attribution needs an image
  // provenance workflow, so this guards its generic renderer independently of that workflow.
  it("renders image attribution with a schema-derived label and warning color", () => {
    render(
      renderOptionCell(
        "ambiguous",
        fieldEnumOptions("image", "captureAttribution"),
      ),
    );
    expect(pillFor("Ambiguous")).toHaveStyle(
      "--enum-pill-color: var(--warning)",
    );
  });

  it("serves a read-only enum's roster without a select control", () => {
    expect(
      fieldEnumOptions("image", "status").map(({ value }) => value),
    ).toEqual(["PENDING", "UPLOADED", "FAILED"]);
    expect(
      fieldEnumOptions("purchase", "financialReconciliation").find(
        ({ value }) => value === "mismatch",
      )?.color,
    ).toBe("var(--destructive)");
  });
});
