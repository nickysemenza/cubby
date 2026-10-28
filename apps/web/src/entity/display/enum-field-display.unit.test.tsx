import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render as testingRender,
  screen,
} from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import { renderOptionCell } from "~/entity/table/column-helpers";

import { financialAccountDetailFields } from "./detail-field-renderers/financial-account";
import { fieldEnumOptions } from "./enum-field-display";

let queryClient: Awaited<ReturnType<typeof metadataQueryClient>>;
beforeEach(async () => {
  queryClient = await metadataQueryClient();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

function MetadataProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function render(ui: ReactNode, options?: Parameters<typeof testingRender>[1]) {
  return testingRender(ui, { wrapper: MetadataProvider, ...options });
}

const pillFor = (label: string) => {
  const pill = screen.getByText(label).closest("[data-enum-role]");
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
        queryClient,
      ).value,
    );

    // A kind reads as the neutral chip, never a condition tone.
    expect(pillFor("Gift card or store credit")).toHaveAttribute(
      "data-enum-role",
      "category",
    );
  });

  it("tones a derived status from the declaration", () => {
    render(
      renderOptionCell(
        "acquired",
        fieldEnumOptions(queryClient, "wish", "acquiredAt"),
      ),
    );

    expect(pillFor("Acquired")).toHaveAttribute("data-enum-role", "status");
    expect(pillFor("Acquired")).toHaveClass("bg-positive-surface");
  });

  // Capture attribution is server-derived; reproducing ambiguous attribution needs an image
  // provenance workflow, so this guards its generic renderer independently of that workflow.
  it("renders image attribution with a schema-derived label and warning color", () => {
    render(
      renderOptionCell(
        "ambiguous",
        fieldEnumOptions(queryClient, "image", "captureAttribution"),
      ),
    );
    expect(pillFor("Ambiguous")).toHaveClass(
      "bg-warning-surface",
      "text-warning-ink",
    );
  });

  it("serves a read-only enum's roster without a select control", () => {
    expect(
      fieldEnumOptions(queryClient, "image", "status").map(
        ({ value }) => value,
      ),
    ).toEqual(["PENDING", "UPLOADED", "FAILED"]);
    expect(
      fieldEnumOptions(queryClient, "purchase", "financialReconciliation").find(
        ({ value }) => value === "mismatch",
      )?.color,
    ).toBe("var(--destructive)");
  });
});
