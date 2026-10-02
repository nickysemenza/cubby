import { fieldSuggestionSchema } from "@cubby/schemas/ai";
import { render, screen, waitFor } from "@testing-library/react";
import { type FieldValues, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { useRowEnumSuggestion } from "./use-row-enum-suggestion";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

type Basis = { identifier: string };

function Probe({
  basis,
  enabled,
  built,
}: {
  basis: Basis;
  enabled: boolean;
  built: Basis[];
}) {
  const form = useForm<FieldValues>({ defaultValues: { kind: "" } });
  const { suggestion } = useRowEnumSuggestion({
    queryOptions: (b: Basis) => {
      built.push(b);
      // Mirrors the operation catalog: input is validated when the options
      // are built, not when the query runs.
      if (b.identifier.length < 2) throw new Error("identifier too short");
      return {
        queryKey: ["probe", b.identifier] as const,
        queryFn: async () =>
          fieldSuggestionSchema.parse({
            value: "asin",
            label: "asin",
            detail: null,
            confidence: "high",
            probability: 1,
            reasoning: "",
          }),
      };
    },
    basis,
    enabled,
    form,
    path: "kind",
    unsetValues: [""],
  });
  return <output data-testid="value">{suggestion?.value ?? "none"}</output>;
}

describe("useRowEnumSuggestion", () => {
  it("never builds query options for a row that is not askable yet", async () => {
    // Regression: a freshly added external-ID row (blank source, empty
    // identifier) threw a ZodError out of `queryOptions` during render and
    // took the whole product dialog down with it, `enabled: false`
    // notwithstanding.
    const built: Basis[] = [];
    render(<Probe basis={{ identifier: "" }} enabled={false} built={built} />, {
      wrapper: harness.wrapper,
    });
    expect(screen.getByTestId("value").textContent).toBe("none");
    expect(built).toEqual([]);
  });

  it("asks once the row is askable and surfaces the answer", async () => {
    const built: Basis[] = [];
    render(
      <Probe basis={{ identifier: "B08N5WRWNW" }} enabled built={built} />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() =>
      expect(screen.getByTestId("value").textContent).toBe("asin"),
    );
    // Rebuilt per render, but only ever with the askable basis.
    expect(built.length).toBeGreaterThan(0);
    expect(new Set(built.map((b) => b.identifier))).toEqual(
      new Set(["B08N5WRWNW"]),
    );
  });
});
