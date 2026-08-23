import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn(() => ({ queryKey: ["problems", "getByType"] })),
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: {
    queryKey: readonly unknown[];
    select?: (value: unknown) => unknown;
  }) => {
    mocks.useQuery(options);
    if (options.queryKey[0] === "entityIntegrity") {
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

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    entityIntegrity: {
      catalog: {
        queryOptions: () => ({ queryKey: ["entityIntegrity", "catalog"] }),
      },
    },
    problems: {
      getByType: { queryOptions: mocks.queryOptions },
    },
  }),
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
    expect(mocks.queryOptions).toHaveBeenCalledWith({
      key: "referentialLivenessViolations",
    });
    const problemQuery = mocks.useQuery.mock.calls
      .map(([options]) => options)
      .find(
        (options: { queryKey: readonly unknown[] }) =>
          options.queryKey[0] === "problems",
      ) as { staleTime?: number };
    expect(problemQuery).toMatchObject({ staleTime: 60_000 });
    expect(mocks.queryOptions).toHaveBeenCalledTimes(1);
  });
});
