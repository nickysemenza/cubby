import type { Entity } from "@cubby/schemas/entity";
import { fireEvent, render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Page } from "~/components/page/Page";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { type DetailSection, DetailSections } from "./detail-page";

const sections: DetailSection[] = [
  {
    id: "summary",
    title: "Summary",
    icon: Circle,
    placement: "supporting",
    content: <p>Summary content</p>,
  },
  {
    id: "story",
    title: "Story",
    icon: Circle,
    placement: "primary",
    content: <p>Story content</p>,
  },
  {
    id: "ledger",
    title: "Ledger",
    icon: Circle,
    placement: "full",
    content: <p>Ledger content</p>,
  },
];

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function renderDetail({
  entity = "image",
  rawData = { id: "IMG-EXAMPLE", filename: "fixture.jpg" },
  detailSections = sections,
  heroMedia,
  relationshipPreview,
  showEntityActions = false,
}: {
  entity?: Entity;
  rawData?: unknown;
  detailSections?: DetailSection[];
  heroMedia?: ReactNode;
  relationshipPreview?: ReactNode;
  showEntityActions?: boolean;
} = {}) {
  return render(
    <Page
      variant="detail"
      title="Fixture detail"
      entity={entity}
      rawData={rawData}
    >
      <DetailSections
        sections={detailSections}
        rawData={rawData}
        heroMedia={heroMedia}
        relationshipPreview={relationshipPreview}
        showEntityActions={showEntityActions}
      />
    </Page>,
    { wrapper: harness.wrapper },
  );
}

describe("DetailSections ledger", () => {
  it("renders responsive tracks and a ruled section index", async () => {
    const { container } = renderDetail();
    expect(await screen.findByText("Sections")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "data-active",
    );
    expect(screen.queryByRole("tab", { name: "Relations" })).toBeNull();
    expect(screen.getByRole("link", { name: "Story" })).toHaveAttribute(
      "href",
      "#story",
    );
    expect(container.querySelector("#story")?.parentElement).toHaveClass(
      "lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]",
    );
    expect(container.querySelector("#story")).toHaveClass("lg:col-start-1");
    expect(container.querySelector("#summary")).toHaveClass("lg:col-start-2");
  });

  it("keeps authored source order and focuses an indexed section", async () => {
    const { container } = renderDetail();
    await screen.findByText("Story content");
    const ids = Array.from(container.querySelectorAll("section")).map(
      (section) => section.id,
    );
    expect(ids).toContain("summary");
    expect(ids).toContain("story");
    expect(ids).toContain("ledger");
    fireEvent.click(screen.getByRole("link", { name: "Story" }));
    expect(document.activeElement).toBe(document.getElementById("story"));
  });

  it("CSS-gates detail media to Overview's desktop rail", async () => {
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "relationships",
          title: "Relationships",
          icon: Circle,
          placement: "full",
          content: <p>Full relationships</p>,
        },
      ],
      heroMedia: <div data-testid="rail-photo">Photo</div>,
    });
    const rail = await screen.findByTestId("detail-rail-media");
    expect(rail).toHaveClass("hidden", "md:block", "lg:col-start-2");
    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("Full relationships")).toBeVisible();
    expect(screen.queryByTestId("rail-photo")).toBeNull();
  });

  it("lets a page-owned relationship section replace the generic explorer", async () => {
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "relationships",
          title: "Relationships",
          icon: Circle,
          placement: "full",
          content: <p>Product route ledger</p>,
        },
      ],
    });
    expect(await screen.findByRole("tab", { name: "Relations" })).toBeVisible();
    expect(screen.queryByText("Product route ledger")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("Product route ledger")).toBeVisible();
  });

  it("lazily mounts authored Relations and Activity", async () => {
    const modeSections: DetailSection[] = [
      ...sections,
      {
        id: "relationships",
        title: "Relationships",
        icon: Circle,
        placement: "full",
        content: <p>Full relationship route</p>,
      },
      {
        id: "history",
        title: "History",
        icon: Circle,
        placement: "supporting",
        content: <p>Authored activity</p>,
      },
    ];
    renderDetail({
      detailSections: modeSections,
      relationshipPreview: <p>Compact relationship route</p>,
    });
    expect(await screen.findByText("Compact relationship route")).toBeVisible();
    expect(screen.queryByText("Full relationship route")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("Full relationship route")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Authored activity")).toBeVisible();
  });

  it("opens supported mode from a router hash and rejects unsupported hashes", async () => {
    await harness.router.navigate({ to: "/", hash: "relationships" });
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "relationships",
          title: "Relationships",
          icon: Circle,
          placement: "full",
          content: <p>Direct relationship route</p>,
        },
      ],
    });
    expect(await screen.findByText("Direct relationship route")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Relations" })).toHaveAttribute(
      "data-active",
    );
  });

  it("omits empty sections without leaving an index target", async () => {
    const [summary, relations] = sections;
    if (!summary || !relations) throw new Error("Expected two detail sections");
    renderDetail({
      detailSections: [
        summary,
        { ...relations, id: "empty", title: "Empty", content: null },
      ],
    });
    await screen.findByText("Summary content");
    expect(screen.queryByText("Empty")).toBeNull();
    expect(screen.queryByText("Sections")).toBeNull();
  });
});
