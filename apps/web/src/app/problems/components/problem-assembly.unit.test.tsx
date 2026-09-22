import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProblemQuery } from "~/entities/problem-query";
import { problemQuery } from "~/entities/problem-registry";

import { ProblemAssembly, problemListLocation } from "./problem-assembly";

describe("problemListLocation", () => {
  it("encodes the canonical entity assembly and keeps worklist contextual", () => {
    const query = problemQuery("productsMissingPrice");
    expect(query).toBeDefined();
    if (!query) return;

    const location = problemListLocation(query);
    expect(location).toMatchObject({ entity: "product" });
    expect(location?.href).toContain("/products?");
    expect(location?.href).toContain("worklist=productsMissingPrice");
    // The view's own filter (the `product_price` data-quality gap) rides on
    // the URL so the list opens narrowed exactly as the Problems count was.
    expect(location?.href).toContain("dataGaps=product_price");
  });

  it("does not create a fake list continuation for derived results", () => {
    const derived: ProblemQuery = {
      key: "duplicateProductIdentities",
      problemClass: "defect",
      executionLane: "fast",
      continuation: { kind: "none", reason: "A cluster is not a list row." },
      title: "Duplicate products",
      description: "",
      emptyMessage: "",
      actions: [],
      freshness: { kind: "live" },
      presenter: {
        key: "duplicateProductIdentities",
        detailRouting: "diagnostic",
      },
      source: {
        kind: "derived" as const,
        diagnostic: "duplicate-product-identities",
        grain: "group" as const,
        operations: [{ label: "Group" }],
      },
    };
    expect(problemListLocation(derived)).toBeUndefined();
  });

  it("fails closed when an entity assembly contains an unknown filter", () => {
    const query = problemQuery("productsMissingPrice");
    const source = query?.source;
    expect(source?.kind).toBe("entity");
    if (!query || source?.kind !== "entity") return;

    expect(() =>
      problemListLocation({
        ...query,
        source: {
          ...source,
          filters: [{ id: "notAProductFilter", value: "x" }],
        },
      }),
    ).toThrow(/unknown product filter notAProductFilter/);
  });

  it("offers each exact branch while leaving a derived branch unlinked", () => {
    const exact = problemQuery("overdueTasks");
    const secondExact = problemQuery("stalledProjects");
    const derived = problemQuery("projectsWithDateDrift");
    expect(exact && secondExact && derived).toBeTruthy();
    if (!exact || !secondExact || !derived) return;
    const exactLocation = problemListLocation(exact);
    const secondLocation = problemListLocation(secondExact);
    expect(exactLocation && secondLocation).toBeTruthy();
    if (!exactLocation || !secondLocation) return;

    render(
      <ProblemAssembly
        queries={[exact, secondExact, derived]}
        listLocations={[
          { query: exact, count: 2, location: exactLocation },
          { query: secondExact, count: 3, location: secondLocation },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /How it works/i }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Open 2 tasks/i })).toHaveAttribute(
      "href",
      expect.stringContaining("worklist=overdueTasks"),
    );
    expect(
      screen.getByRole("link", { name: /Open 3 projects/i }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("worklist=stalledProjects"),
    );
  });
});
