import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogQueryOptions: vi.fn(() => ({
    queryKey: [["entityIntegrity", "catalog"]],
  })),
  violationsQueryOptions: vi.fn(() => ({
    queryKey: [["problems", "getByType"]],
  })),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: {
    queryKey: readonly unknown[];
    select?: (value: unknown) => unknown;
  }) => {
    mocks.useQuery(options);
    const queryRoot = Array.isArray(options.queryKey[0])
      ? options.queryKey[0][0]
      : options.queryKey[0];
    if (queryRoot === "entityIntegrity") {
      return {
        data: {
          coverage: {
            relationships: 0,
            incomingEdges: 0,
            auditedEdges: 0,
            exemptEdges: 0,
            operations: 0,
          },
          entities: [],
          operations: [],
        },
        isLoading: false,
      };
    }
    return { data: options.select?.({ items: [] }), isLoading: false };
  },
}));

vi.mock("~/entities/entity-integrity.functions", () => ({
  entityIntegrity: { catalog: { queryOptions: mocks.catalogQueryOptions } },
  integrityProblems: {
    getByType: { queryOptions: mocks.violationsQueryOptions },
  },
  REFERENTIAL_LIVENESS_INPUT: { key: "referentialLivenessViolations" },
}));

// If this broad dashboard hook returns, the integrity tab has regressed back to
// running all five Problems lanes instead of its focused detector query.
vi.mock("~/app/problems/use-problems-data", () => ({
  useProblemsData: () => {
    throw new Error("EntityIntegrityTab must not load full Problems data");
  },
}));

vi.mock("./EntityReferenceGraph", () => ({
  EntityReferenceGraph: () => <div data-testid="reference-graph" />,
}));

import { EntityIntegrityTab } from "./EntityIntegrityTab";

describe("EntityIntegrityTab", () => {
  it("loads only referential-liveness violations at the focused 60s window", () => {
    render(<EntityIntegrityTab />);

    expect(screen.getByTestId("reference-graph")).toBeInTheDocument();
    expect(mocks.catalogQueryOptions).toHaveBeenCalledTimes(1);
    expect(mocks.violationsQueryOptions).toHaveBeenCalledTimes(1);
    const problemQuery = mocks.useQuery.mock.calls
      .map(([options]) => options)
      .find(
        (options: { queryKey: readonly unknown[] }) =>
          (Array.isArray(options.queryKey[0])
            ? options.queryKey[0][0]
            : options.queryKey[0]) === "problems",
      ) as { staleTime?: number };
    expect(problemQuery).toMatchObject({ staleTime: 60_000 });
  });
});
