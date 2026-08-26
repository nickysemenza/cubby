import type { RelatedPreviewGroup } from "@cubby/schemas/related-view";
import { relatedViewsFor } from "@cubby/schemas/related-view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { relatedData } from "~/lib/related-data.functions";
import {
  RelationshipRoutePreview,
  relationshipRoutePreviewModel,
} from "./relationship-route-preview";

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
      <RelationshipRoutePreview entity="vendor" sourceId={SOURCE_ID} />
    </QueryClientProvider>,
  );
}

describe("relationshipRoutePreviewModel", () => {
  it("chooses the first nonempty registered edge and preserves endpoint siblings", () => {
    const model = relationshipRoutePreviewModel({
      entity: "vendor",
      sourceId: SOURCE_ID,
      views: relatedViewsFor("vendor"),
      groups,
    });

    expect(model).toMatchObject({
      source: { entity: "vendor", id: SOURCE_ID, label: "Vendor" },
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
});

describe("RelationshipRoutePreview", () => {
  it("renders one source edge followed by canonical sibling endpoint links", () => {
    renderPreview();

    expect(screen.getByTestId("relationship-route-preview")).toBeVisible();
    expect(screen.getByText("Vendor")).toBeVisible();
    expect(screen.getByText("Products")).toBeVisible();
    expect(screen.getByText("+2")).toBeVisible();
    expect(screen.getByRole("list")).toHaveAttribute(
      "aria-label",
      "Products endpoints",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("First endpoint").closest("a")).toHaveAttribute(
      "href",
      "/products/PRD-ONE",
    );
    expect(screen.getByText("Second endpoint").closest("a")).toHaveAttribute(
      "href",
      "/products/PRD-TWO",
    );
  });
});
