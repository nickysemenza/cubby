import { fireEvent, render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DetailSection, DetailSections } from "./detail-page";

const mocks = vi.hoisted(() => ({
  debug: { current: false },
  pageDetail: { current: undefined as unknown },
  routerHash: { current: "" },
  navigate: vi.fn(),
  relationshipExplorer: vi.fn(),
  relationshipRoute: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({
    select,
  }: {
    select: (location: { hash: string }) => string;
  }) => select({ hash: mocks.routerHash.current }),
  useNavigate: () => mocks.navigate,
}));
vi.mock("~/hooks/useDebug", () => ({
  useDebug: () => ({ isDebugEnabled: mocks.debug.current }),
}));
vi.mock("~/components/page/Page", () => ({
  usePageDetailContext: () => mocks.pageDetail.current,
}));
vi.mock("../relationships/relationship-explorer", () => ({
  RelationshipExplorer: (props: unknown) => {
    mocks.relationshipExplorer(props);
    return <div data-testid="generic-relationships">Generic relationships</div>;
  },
}));
vi.mock("../relationships/relationship-route-preview", () => ({
  RelationshipRoutePreview: (props: unknown) => {
    mocks.relationshipRoute(props);
    return <div data-testid="relationship-route-preview" />;
  },
  relationshipRouteSourceFromRecord: (
    entity: string,
    rawData: { id?: string; name?: string },
  ) =>
    rawData.id && rawData.name
      ? { entity, id: rawData.id, label: rawData.name }
      : null,
}));
vi.mock("../audit-log/audit-log-list", () => ({
  AuditLogList: () => <div data-testid="audit-log">Audit log</div>,
}));

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

describe("DetailSections ledger", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    mocks.debug.current = false;
    mocks.pageDetail.current = undefined;
    mocks.routerHash.current = "";
    mocks.navigate.mockReset();
    mocks.navigate.mockImplementation(
      ({ hash }: { hash?: string; replace?: boolean }) => {
        mocks.routerHash.current = hash ?? "";
      },
    );
    mocks.relationshipExplorer.mockClear();
    mocks.relationshipRoute.mockClear();
  });

  it("renders stable responsive tracks and a ruled section index", () => {
    const { container } = render(
      <DetailSections sections={sections} rawData={{ id: "example" }} />,
    );

    expect(screen.getByText("Sections")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "data-active",
    );
    expect(screen.queryByRole("tab", { name: "Relations" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
    expect(screen.getByRole("link", { name: "Story" })).toHaveAttribute(
      "href",
      "#story",
    );
    expect(container.querySelector("#story")?.parentElement).toHaveClass(
      "lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]",
    );
    expect(container.querySelector("#story")).toHaveClass("lg:col-start-1");
    expect(container.querySelector("#summary")).toHaveClass("lg:col-start-2");
    expect(
      screen.getByRole("heading", { name: "Story", level: 2 }),
    ).toBeInTheDocument();
  });

  it("keeps authored source order in the CSS-responsive phone column", () => {
    const { container } = render(
      <DetailSections sections={sections} rawData={{ id: "example" }} />,
    );

    const ids = Array.from(container.querySelectorAll("section")).map(
      (section) => section.id,
    );
    expect(ids).toEqual(["summary", "story", "ledger"]);
    expect(
      screen.getByRole("navigation", { name: "Record sections" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Summary" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("CSS-gates detail media to the desktop rail without viewport branching", () => {
    render(
      <DetailSections
        sections={[
          ...sections,
          {
            id: "relationships",
            title: "Relationships",
            icon: Circle,
            placement: "full",
            content: <p>Full relationships</p>,
          },
        ]}
        rawData={{ id: "example" }}
        heroMedia={<div data-testid="rail-photo">Photo</div>}
      />,
    );

    const rail = screen.getByTestId("detail-rail-media");
    expect(rail).toHaveClass("hidden", "md:block", "lg:col-start-2");
    expect(screen.getAllByTestId("rail-photo")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.queryByTestId("rail-photo")).toBeNull();
  });

  it("keeps raw debug details in Overview", () => {
    mocks.debug.current = true;
    render(
      <DetailSections
        sections={[
          ...sections,
          {
            id: "history",
            title: "History",
            icon: Circle,
            placement: "supporting",
            content: <p>Activity content</p>,
          },
        ]}
        rawData={{ id: "example" }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Raw Details" })).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.queryByRole("heading", { name: "Raw Details" })).toBeNull();
  });

  it("moves keyboard focus to an indexed section", () => {
    render(<DetailSections sections={sections} rawData={{ id: "example" }} />);

    fireEvent.click(screen.getByRole("link", { name: "Story" }));
    expect(document.activeElement).toBe(document.getElementById("story"));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: ".",
      hash: "story",
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  });

  it("does not re-focus an ordinary section hash after an unrelated render", () => {
    mocks.routerHash.current = "story";
    const { rerender } = render(
      <DetailSections sections={sections} rawData={{ id: "example" }} />,
    );

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById("story"));

    rerender(
      <DetailSections sections={[...sections]} rawData={{ id: "example" }} />,
    );

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate section ids", () => {
    expect(() =>
      render(
        <DetailSections
          sections={[sections[0]!, { ...sections[1]!, id: "summary" }]}
          rawData={{ id: "example" }}
        />,
      ),
    ).toThrow("Detail section ids must be unique within a record page");
  });

  it("lets a page-owned relationships section replace the generic explorer", () => {
    mocks.pageDetail.current = {
      entity: "product",
      rawData: { id: "PRD-EXAMPLE" },
    };

    render(
      <DetailSections
        sections={[
          ...sections,
          {
            id: "relationships",
            title: "Relationships",
            icon: Circle,
            placement: "full",
            content: <p>Product route ledger</p>,
          },
        ]}
        rawData={{ id: "PRD-EXAMPLE" }}
      />,
    );

    expect(screen.getByRole("tab", { name: "Relations" })).toBeVisible();
    expect(screen.queryByText("Product route ledger")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("generic-relationships"),
    ).not.toBeInTheDocument();
    expect(mocks.relationshipExplorer).not.toHaveBeenCalled();
    expect(mocks.relationshipRoute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("Product route ledger")).toBeInTheDocument();
    expect(screen.queryByText("Story content")).not.toBeInTheDocument();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: ".",
      hash: "relationships",
      replace: false,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  });

  it("adds the bounded route preview before a generic relationship explorer", () => {
    mocks.pageDetail.current = {
      entity: "vendor",
      rawData: { id: "VEN-EXAMPLE", name: "Fixture vendor" },
    };

    render(
      <DetailSections sections={sections} rawData={{ id: "VEN-EXAMPLE" }} />,
    );

    expect(screen.getByTestId("relationship-route-preview")).toBeVisible();
    expect(screen.queryByTestId("generic-relationships")).toBeNull();
    expect(screen.getAllByTestId("relationship-route-preview")).toHaveLength(1);
    expect(mocks.relationshipRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "vendor",
        sourceId: "VEN-EXAMPLE",
        source: {
          entity: "vendor",
          id: "VEN-EXAMPLE",
          label: "Fixture vendor",
        },
      }),
    );
    const sectionIds = Array.from(
      document.querySelectorAll("section"),
      (section) => section.id,
    );
    expect(sectionIds).not.toContain("relationships");

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.queryByTestId("relationship-route-preview")).toBeNull();
    expect(screen.getByTestId("generic-relationships")).toBeVisible();
    expect(mocks.relationshipExplorer).toHaveBeenCalledWith({
      entity: "vendor",
      sourceId: "VEN-EXAMPLE",
    });
  });

  it("lazily mounts authored Relations and Activity while keeping the compact route in Overview", () => {
    const relationshipMount = vi.fn();
    const activityMount = vi.fn();
    const LazyRelationship = () => {
      relationshipMount();
      return <p>Full relationship route</p>;
    };
    const LazyActivity = () => {
      activityMount();
      return <p>Authored activity</p>;
    };
    const modeSections: DetailSection[] = [
      ...sections,
      {
        id: "relationships",
        title: "Relationships",
        icon: Circle,
        placement: "full",
        content: <LazyRelationship />,
      },
      {
        id: "history",
        title: "History",
        icon: Circle,
        placement: "supporting",
        content: <LazyActivity />,
      },
    ];

    const { rerender } = render(
      <DetailSections
        sections={modeSections}
        rawData={{ id: "example" }}
        relationshipPreview={<p>Compact relationship route</p>}
      />,
    );

    expect(screen.getByText("Compact relationship route")).toBeVisible();
    expect(relationshipMount).not.toHaveBeenCalled();
    expect(activityMount).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Relations" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByText("Full relationship route")).toBeVisible();
    expect(screen.queryByText("Compact relationship route")).toBeNull();
    expect(relationshipMount).toHaveBeenCalledTimes(1);
    expect(activityMount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("Authored activity")).toBeVisible();
    expect(activityMount).toHaveBeenCalledTimes(1);

    mocks.routerHash.current = "relationships";
    rerender(
      <DetailSections
        sections={modeSections}
        rawData={{ id: "example" }}
        relationshipPreview={<p>Compact relationship route</p>}
      />,
    );
    expect(screen.getByText("Full relationship route")).toBeVisible();

    mocks.routerHash.current = "story";
    rerender(
      <DetailSections
        sections={modeSections}
        rawData={{ id: "example" }}
        relationshipPreview={<p>Compact relationship route</p>}
      />,
    );
    expect(screen.getByText("Story content")).toBeVisible();
    expect(document.activeElement).toBe(document.getElementById("story"));

    mocks.routerHash.current = "history";
    rerender(
      <DetailSections
        sections={modeSections}
        rawData={{ id: "example" }}
        relationshipPreview={<p>Compact relationship route</p>}
      />,
    );
    expect(screen.getByText("Authored activity")).toBeVisible();
  });

  it("opens a supported mode directly from the initial URL hash", () => {
    mocks.routerHash.current = "relationships";

    render(
      <DetailSections
        sections={[
          ...sections,
          {
            id: "relationships",
            title: "Relationships",
            icon: Circle,
            placement: "full",
            content: <p>Direct relationship route</p>,
          },
        ]}
        rawData={{ id: "example" }}
        relationshipPreview={<p>Compact relationship route</p>}
      />,
    );

    expect(screen.getByRole("tab", { name: "Relations" })).toHaveAttribute(
      "data-active",
    );
    expect(screen.getByText("Direct relationship route")).toBeVisible();
    expect(screen.queryByText("Compact relationship route")).toBeNull();
  });

  it("falls back to the clean Overview URL for unsupported mode or section hashes", () => {
    mocks.routerHash.current = "relationships";
    const { rerender } = render(
      <DetailSections sections={sections} rawData={{ id: "example" }} />,
    );

    expect(screen.getByText("Story content")).toBeVisible();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: ".",
      hash: undefined,
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });

    mocks.navigate.mockClear();
    mocks.routerHash.current = "not-a-section";
    rerender(
      <DetailSections sections={sections} rawData={{ id: "example" }} />,
    );
    expect(screen.getByText("Story content")).toBeVisible();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: ".",
      hash: undefined,
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  });

  it("adds Activity for auditable entities and mounts its audit log only when selected", () => {
    mocks.pageDetail.current = {
      entity: "vendor",
      rawData: { id: "VEN-EXAMPLE", name: "Fixture vendor" },
    };

    render(
      <DetailSections sections={sections} rawData={{ id: "VEN-EXAMPLE" }} />,
    );

    expect(screen.getByRole("tab", { name: "Activity" })).toBeVisible();
    expect(screen.queryByTestId("audit-log")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByTestId("audit-log")).toBeVisible();
    expect(screen.queryByTestId("generic-relationships")).toBeNull();
  });

  it("omits empty sections without leaving an index target", () => {
    render(
      <DetailSections
        sections={[
          sections[0]!,
          { ...sections[1]!, id: "empty", title: "Empty", content: null },
        ]}
        rawData={{ id: "example" }}
      />,
    );

    expect(screen.queryByText("Empty")).not.toBeInTheDocument();
    expect(screen.queryByText("Sections")).not.toBeInTheDocument();
  });
});
