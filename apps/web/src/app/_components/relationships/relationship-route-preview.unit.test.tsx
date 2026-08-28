import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { relatedData } from "~/lib/related-data.functions";

import {
  RelationshipRoutePreview,
  relationshipRoutePreviewModel,
  relationshipRouteSourceFromRecord,
  useRelationshipRouteSource,
} from "./relationship-route-preview";

const relatedPreviewsQuery = vi.hoisted(() => vi.fn());

vi.mock("~/lib/related-data.functions", () => ({
  relatedData: {
    previews: {
      queryOptions: (input: unknown) => ({
        queryKey: ["related-previews", input],
        queryFn: relatedPreviewsQuery,
      }),
    },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    params?: { id?: string; shortcode?: string };
  }) => (
    <a
      {...props}
      href={to
        .replace("$id", params?.id ?? "")
        .replace("$shortcode", params?.shortcode ?? "")}
    >
      {children}
    </a>
  ),
}));

const SOURCE_ID = "VEN-ROUTE";
const groups: RelatedPreviewGroup[] = [
  {
    sourceId: SOURCE_ID,
    relationKey: "vendor.products",
    totalCount: 5,
    items: [
      {
        entity: "product",
        id: "PRD-ONE",
        label: "First endpoint",
        displayImage: null,
      },
      {
        entity: "product",
        id: "PRD-TWO",
        label: "Second endpoint",
        displayImage: null,
      },
      {
        entity: "product",
        id: "PRD-THREE",
        label: "Third endpoint",
        displayImage: null,
      },
    ],
  },
];

const MEAL_ID = "MEL-ROUTE";
const mealGroups: RelatedPreviewGroup[] = [
  {
    sourceId: MEAL_ID,
    relationKey: "meal.recipes",
    totalCount: 1,
    items: [
      {
        entity: "recipe",
        id: "RCP-ONE",
        label: "Fixture recipe",
        displayImage: null,
      },
    ],
  },
];

beforeEach(() => {
  relatedPreviewsQuery.mockReset();
});

function renderPreview() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const views = relatedViewsFor("vendor");
  queryClient.setQueryData(
    relatedData.previews.queryOptions({
      source: "vendor",
      sourceIds: [SOURCE_ID],
      relationKeys: views.map((view) => view.key),
    }).queryKey,
    groups,
  );

  return render(
    <QueryClientProvider client={queryClient}>
      <RelationshipRoutePreview
        entity="vendor"
        sourceId={SOURCE_ID}
        source={{ entity: "vendor", id: SOURCE_ID, label: "Fixture vendor" }}
      />
    </QueryClientProvider>,
  );
}

function renderPreviewState({
  groups: data,
  queryFn,
}: {
  groups?: RelatedPreviewGroup[];
  queryFn: () => Promise<RelatedPreviewGroup[]>;
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const views = relatedViewsFor("vendor");
  const options = relatedData.previews.queryOptions({
    source: "vendor",
    sourceIds: [SOURCE_ID],
    relationKeys: views.map((view) => view.key),
  });
  relatedPreviewsQuery.mockImplementation(queryFn);
  if (data) queryClient.setQueryData(options.queryKey, data);

  return render(
    <QueryClientProvider client={queryClient}>
      <RelationshipRoutePreview
        entity="vendor"
        sourceId={SOURCE_ID}
        source={{ entity: "vendor", id: SOURCE_ID, label: "Fixture vendor" }}
      />
    </QueryClientProvider>,
  );
}

describe("relationshipRoutePreviewModel", () => {
  it("chooses the first nonempty registered edge and preserves endpoint siblings", () => {
    const model = relationshipRoutePreviewModel({
      source: { entity: "vendor", id: SOURCE_ID, label: "Fixture vendor" },
      views: relatedViewsFor("vendor"),
      groups,
    });

    expect(model).toMatchObject({
      source: { entity: "vendor", id: SOURCE_ID, label: "Fixture vendor" },
      relation: {
        key: "vendor.products",
        label: "Products",
        totalCount: 5,
      },
    });
    expect(model?.relation.endpoints.map((endpoint) => endpoint.id)).toEqual([
      "PRD-ONE",
      "PRD-TWO",
      "PRD-THREE",
    ]);
  });

  it("uses the configured loaded-record identity rather than an entity noun", () => {
    expect(
      relationshipRouteSourceFromRecord("vendor", {
        id: SOURCE_ID,
        name: "Fixture vendor",
      }),
    ).toEqual({
      entity: "vendor",
      id: SOURCE_ID,
      label: "Fixture vendor",
    });
  });

  it("keeps an unnamed Meal's date identity and canonical route", () => {
    const source = relationshipRouteSourceFromRecord("meal", {
      id: MEAL_ID,
      name: "",
      date: "2026-01-02",
    });
    expect(source).toEqual({ entity: "meal", id: MEAL_ID, label: "Jan 2" });
    expect(
      relationshipRoutePreviewModel({
        source: source!,
        views: relatedViewsFor("meal"),
        groups: mealGroups,
      }),
    ).toMatchObject({ source });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(
      relatedData.previews.queryOptions({
        source: "meal",
        sourceIds: [MEAL_ID],
        relationKeys: relatedViewsFor("meal").map((view) => view.key),
      }).queryKey,
      mealGroups,
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RelationshipRoutePreview
          entity="meal"
          sourceId={MEAL_ID}
          source={source}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Jan 2").closest("a")).toHaveAttribute(
      "href",
      `/meals/${MEAL_ID}`,
    );
  });

  it("subscribes to an already-loaded inspector preview without fetching again", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(
      entityPreviewQueryOptions("vendor", SOURCE_ID).queryKey,
      { id: SOURCE_ID, name: "Fixture vendor" },
    );

    const { result } = renderHook(
      () => useRelationshipRouteSource("vendor", SOURCE_ID),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );

    expect(result.current).toEqual({
      entity: "vendor",
      id: SOURCE_ID,
      label: "Fixture vendor",
    });
    expect(
      queryClient.getQueryState(
        entityPreviewQueryOptions("vendor", SOURCE_ID).queryKey,
      )?.fetchStatus,
    ).toBe("idle");
  });
});

describe("RelationshipRoutePreview", () => {
  it("renders one source edge followed by canonical sibling endpoint links", () => {
    renderPreview();

    expect(screen.getByTestId("relationship-route-preview")).toBeVisible();
    expect(screen.getByText("Fixture vendor")).toBeVisible();
    expect(screen.getByText("Products")).toBeVisible();
    expect(screen.getByText("+2")).toBeVisible();
    expect(screen.getByRole("list")).toHaveAttribute(
      "aria-label",
      "Products endpoints",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("Fixture vendor").closest("a")).toHaveAttribute(
      "href",
      `/vendors/${SOURCE_ID}`,
    );
    expect(screen.getByText("First endpoint").closest("a")).toHaveAttribute(
      "href",
      "/products/PRD-ONE",
    );
    expect(screen.getByText("Second endpoint").closest("a")).toHaveAttribute(
      "href",
      "/products/PRD-TWO",
    );
  });

  it("keeps an empty relationship preview distinct from an unavailable strip", () => {
    renderPreviewState({ groups: [], queryFn: async () => [] });

    expect(
      screen.getByTestId("relationship-route-preview-state"),
    ).toHaveTextContent("No linked records.");
  });

  it("renders loading while the existing relationship query is pending", () => {
    renderPreviewState({
      queryFn: () => new Promise<RelatedPreviewGroup[]>(() => undefined),
    });

    expect(
      screen.getByTestId("relationship-route-preview-state"),
    ).toHaveTextContent("Loading relationships…");
  });

  it("offers local retry when the existing relationship query fails", async () => {
    const queryFn = vi.fn(async () => {
      throw new Error("Fixture failure");
    });
    renderPreviewState({ queryFn });

    expect(
      await screen.findByText("Relationships could not be loaded."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });
});
