import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityGraph } from "~/entities/entity-graph.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RelationFieldWorkbench } from "./relation-field-workbench";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("RelationFieldWorkbench", () => {
  it("loads inspectable relation records only after opening", async () => {
    const graph = vi.fn(async () => ({
      nodes: [
        {
          entityType: "financialTransaction" as const,
          entityId: "FTX-2345",
          label: "Neighborhood Market",
          metadata: {},
        },
      ],
      edges: [],
      branches: [
        {
          root: { entityType: "purchase" as const, entityId: "PUR-2345" },
          relationshipKey: "financial-transactions",
          label: "Financial transactions",
          target: "financialTransaction" as const,
          totalCount: 1,
          nextOffset: null,
          items: [
            {
              entityType: "financialTransaction" as const,
              entityId: "FTX-2345",
            },
          ],
          edgeIds: [],
        },
      ],
      truncated: false,
    }));
    render(
      <RelationFieldWorkbench
        sourceEntity="purchase"
        sourceId="PUR-2345"
        provenance={{
          kind: "derived",
          sources: [
            {
              entity: "financialTransaction",
              label: null,
              relation: "financial-transactions",
            },
          ],
        }}
        summary={<span>Settled · 1</span>}
        operations={{ graph: entityGraph.graph.withTransport(graph) }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(graph).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect related records" }),
    );
    expect(await screen.findByText("Neighborhood Market")).toBeVisible();
    expect(graph).toHaveBeenCalledOnce();
  });

  it("leaves non-inspectable aggregate provenance inert", () => {
    render(
      <RelationFieldWorkbench
        sourceEntity="purchase"
        sourceId="PUR-2345"
        provenance={{
          kind: "derived",
          sources: [
            { entity: null, label: "Calculated total", relation: null },
          ],
        }}
        summary={<span>42</span>}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByText("42")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("leaves direct reference content on its existing link", () => {
    render(
      <RelationFieldWorkbench
        sourceEntity="inventory"
        sourceId="INV-2345"
        provenance={{
          kind: "reference",
          sources: [{ entity: "product", label: null, relation: "product" }],
        }}
        summary={<a href="/products/PRD-2345">Tomatoes</a>}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("link", { name: "Tomatoes" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
