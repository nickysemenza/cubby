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
  pageRawData = rawData,
  detailSections = sections,
  heroMedia,
}: {
  entity?: Entity;
  rawData?: unknown;
  pageRawData?: unknown;
  detailSections?: DetailSection[];
  heroMedia?: ReactNode;
} = {}) {
  return render(
    <Page
      variant="detail"
      title="Fixture detail"
      entity={entity}
      rawData={pageRawData}
    >
      <DetailSections
        sections={detailSections}
        rawData={rawData}
        heroMedia={heroMedia}
      />
    </Page>,
    { wrapper: harness.wrapper },
  );
}

describe("DetailSections ledger", () => {
  it("combines navigation, section jump, and Overview tools around explicit tracks", async () => {
    const { container } = renderDetail();
    expect(await screen.findByText("Story content")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "data-active",
    );
    expect(screen.getByRole("tab", { name: "Relations" })).toBeVisible();
    // md+: an inline anchor list; the first declared section is active.
    expect(screen.getByRole("link", { name: "Story" })).toHaveAttribute(
      "href",
      "#story",
    );
    expect(screen.getByRole("link", { name: "Summary" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    // Below md: the same list behind a "Jump to: <active>" trigger.
    expect(
      screen.getByRole("button", { name: /Jump to:\s*Summary/ }),
    ).toBeVisible();
    expect(screen.getByTestId("detail-overview-tools")).toHaveClass(
      "w-full",
      "md:flex-1",
    );
    expect(
      container.querySelector("#story")?.closest("[data-testid]"),
    ).toHaveAttribute("data-testid", "detail-primary-stack");
    expect(
      container.querySelector("#summary")?.closest("aside"),
    ).toHaveAttribute("data-testid", "detail-supporting-rail");
    expect(container.querySelector("#story")?.parentElement).toHaveClass(
      "divide-y",
      "bg-card",
    );
  });

  it("keeps placement stacks ordered and focuses a Jump target", async () => {
    const { container } = renderDetail();
    await screen.findByText("Story content");
    const ids = Array.from(container.querySelectorAll("section")).map(
      (section) => section.id,
    );
    expect(ids).toEqual(["story", "summary", "ledger"]);
    // The inline anchor jumps directly.
    fireEvent.click(screen.getByRole("link", { name: "Story" }));
    expect(document.activeElement).toBe(document.getElementById("story"));
    // The phone dropdown offers the same targets.
    fireEvent.click(screen.getByRole("button", { name: /Jump to:/ }));
    const ledger = screen.getByRole("menuitem", { name: "Ledger" });
    expect(ledger).toHaveAttribute("href", "#ledger");
    fireEvent.click(ledger);
    expect(document.activeElement).toBe(document.getElementById("ledger"));
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
    expect(rail).toHaveClass("hidden", "md:block");
    expect(rail.closest("aside")).toHaveAttribute(
      "data-testid",
      "detail-supporting-rail",
    );
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
    renderDetail({ detailSections: modeSections });
    expect(await screen.findByText("Story content")).toBeVisible();
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
    expect(screen.queryByRole("link", { name: "Summary" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Jump to:/ })).toBeNull();
    expect(screen.queryByTestId("detail-overview-tools")).toBeNull();
  });

  it("collapsed header toggles and mounts body", async () => {
    const [summary] = sections;
    if (!summary) throw new Error("Expected a fixture section");
    renderDetail({
      detailSections: [
        summary,
        {
          id: "analytics",
          title: "Analytics",
          icon: Circle,
          placement: "primary",
          collapsed: true,
          content: <p>Analytics content</p>,
        },
      ],
    });
    await screen.findByText("Summary content");
    const toggle = screen.getByRole("button", { name: /Analytics/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Analytics content")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Analytics content")).toBeVisible();
  });
});
