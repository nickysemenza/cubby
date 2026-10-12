import type { Entity } from "@cubby/schemas/entity";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { Page } from "~/ui/page/Page";

import {
  type DetailSection,
  DetailSections,
  useSectionEmpty,
} from "./detail-page";

const sections: DetailSection[] = [
  {
    id: "summary",
    title: "Summary",
    icon: CircleIcon,
    placement: "supporting",
    content: <p>Summary content</p>,
  },
  {
    id: "story",
    title: "Story",
    icon: CircleIcon,
    placement: "primary",
    content: <p>Story content</p>,
  },
  {
    id: "ledger",
    title: "Ledger",
    icon: CircleIcon,
    placement: "full",
    content: <p>Ledger content</p>,
  },
];

let harness: ReturnType<typeof createBrowserTestHarness>;
let unmountRouter: () => void;

beforeEach(() => {
  harness = createBrowserTestHarness();
  // RouterContextProvider omits Transitioner; retain its real history subscription
  // so browser Back updates router state as it does in the mounted application.
  unmountRouter = harness.router.history.subscribe(harness.router.load);
});
afterEach(() => {
  cleanup();
  unmountRouter();
  harness.dispose();
});

function renderDetail({
  entity = "image",
  rawData = { filename: "fixture.jpg" },
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

// Navigation must retain drafts, stable hashes, and section actions even when
// asynchronous relation content becomes empty.
function EmptyReportingContent() {
  const [empty, setEmpty] = useState(false);
  useSectionEmpty(empty);
  return <button onClick={() => setEmpty(true)}>Resolve empty work</button>;
}

function CollapsedContent() {
  useSectionEmpty(true);
  return <p>Empty rows content</p>;
}

function PendingContent() {
  return <p>Loading connections…</p>;
}

describe("continuous detail sections", () => {
  it("retains a workspace draft while section links move focus", async () => {
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "source-events",
          title: "Source events",
          icon: CircleIcon,
          placement: "full",
          workspace: "evidence",
          content: <p>Complete source history</p>,
        },
        {
          id: "review",
          title: "Review",
          icon: CircleIcon,
          placement: "full",
          workspace: "work",
          content: <input aria-label="Review note" defaultValue="" />,
        },
      ],
    });
    expect(await screen.findByText("Story content")).toBeVisible();
    expect(screen.getByText("Complete source history")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(
      screen.getByRole("link", { hidden: true, name: "Source events" }),
    );
    expect(document.activeElement).toBe(
      document.getElementById("source-events"),
    );
    fireEvent.click(screen.getByRole("link", { hidden: true, name: "Review" }));
    expect(screen.getByRole("textbox", { name: "Review note" })).toHaveValue(
      "Keep this draft",
    );
    expect(screen.getByText("Story content")).toBeVisible();
  });

  it("preserves supporting hash targets and offers the same compact jump action", async () => {
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "fits-with",
          title: "Similar products",
          icon: CircleIcon,
          placement: "full",
          overview: false,
          content: <p>Similarity evidence</p>,
        },
      ],
    });
    expect(await screen.findByText("Similarity evidence")).toBeVisible();
    expect(
      screen.getByRole("navigation", { hidden: true, name: "Section index" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("link", { hidden: true, name: "Similar products" }),
    );
    await waitFor(() =>
      expect(harness.router.state.location.hash).toBe("fits-with"),
    );
    expect(document.activeElement).toBe(document.getElementById("fits-with"));
    expect(screen.getByText("Story content")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Jump to:/ }));
    const ledger = screen.getByRole("menuitem", { name: "Ledger" });
    expect(ledger).toHaveAttribute("href", "#ledger");
    fireEvent.click(ledger);
    expect(document.activeElement).toBe(document.getElementById("ledger"));
  });

  it("preserves authored relationship and activity sections with direct hash navigation", async () => {
    await harness.router.navigate({ to: "/", hash: "relationships" });
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "relationships",
          title: "Relationships",
          icon: CircleIcon,
          placement: "full",
          content: <p>Direct relationship route</p>,
        },
        {
          id: "history",
          title: "History",
          icon: CircleIcon,
          placement: "supporting",
          content: <p>Authored activity</p>,
        },
      ],
    });
    expect(await screen.findByText("Direct relationship route")).toBeVisible();
    expect(screen.getByText("Authored activity")).toBeVisible();
    expect(screen.getByText("Story content")).toBeVisible();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById("relationships"),
      ),
    );
    fireEvent.click(
      screen.getByRole("link", { hidden: true, name: "History" }),
    );
    await waitFor(() =>
      expect(harness.router.state.location.hash).toBe("history"),
    );
    await waitFor(() => expect(harness.router.state.status).toBe("idle"));
    harness.router.history.back();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById("relationships"),
      ),
    );
  });

  it("keeps resolved empty work discoverable with its action and index target", async () => {
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "work-result",
          title: "Work result",
          icon: CircleIcon,
          placement: "full",
          workspace: "work",
          headerAction: <button>Add work</button>,
          content: <EmptyReportingContent />,
        },
      ],
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Resolve empty work" }),
    );
    expect(screen.getByRole("heading", { name: "Work result" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add work" })).toBeVisible();
    expect(
      screen.getByRole("link", { hidden: true, name: /Work result/ }),
    ).toBeInTheDocument();
    const section = document.getElementById("work-result");
    if (!section) throw new Error("Expected work-result section");
    expect(
      await within(section).findByText("Empty", { exact: true }),
    ).toBeVisible();
  });

  it("opens collapsed declarations and keeps their create actions", async () => {
    renderDetail({
      detailSections: [
        {
          id: "analytics",
          title: "Analytics",
          icon: CircleIcon,
          placement: "primary",
          collapsed: true,
          content: <p>Analytics content</p>,
        },
        {
          id: "relation",
          title: "Relation",
          icon: CircleIcon,
          placement: "primary",
          headerAction: <button>Add</button>,
          content: <CollapsedContent />,
        },
      ],
    });
    expect(await screen.findByText("Analytics content")).toBeVisible();
    expect(screen.getByText("Empty rows content")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add" })).toBeVisible();
  });

  it("includes pending and null sections in the index without hiding their headings", async () => {
    renderDetail({
      detailSections: [
        ...sections,
        {
          id: "relation",
          title: "Relation",
          icon: CircleIcon,
          placement: "primary",
          content: <PendingContent />,
        },
        {
          id: "empty",
          title: "Empty section",
          icon: CircleIcon,
          placement: "full",
          content: null,
        },
      ],
    });
    expect(await screen.findByText("Loading connections…")).toBeVisible();
    expect(
      screen.getByRole("link", { hidden: true, name: "Relation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Empty section" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { hidden: true, name: /Empty section/ }),
    ).toBeInTheDocument();
  });
});
