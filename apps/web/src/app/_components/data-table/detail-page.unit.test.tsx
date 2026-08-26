import { fireEvent, render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DetailSection, DetailSections } from "./detail-page";

const mocks = vi.hoisted(() => ({
  pageDetail: { current: undefined as unknown },
  relationshipExplorer: vi.fn(),
  relationshipRoute: vi.fn(),
}));

vi.mock("~/hooks/useDebug", () => ({
  useDebug: () => ({ isDebugEnabled: false }),
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
    mocks.pageDetail.current = undefined;
    mocks.relationshipExplorer.mockClear();
    mocks.relationshipRoute.mockClear();
  });

  it("renders stable responsive tracks and a ruled section index", () => {
    const { container } = render(
      <DetailSections sections={sections} rawData={{ id: "example" }} />,
    );

    expect(screen.getByText("Sections")).toBeInTheDocument();
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
        sections={sections}
        rawData={{ id: "example" }}
        heroMedia={<div data-testid="rail-photo">Photo</div>}
      />,
    );

    const rail = screen.getByTestId("detail-rail-media");
    expect(rail).toHaveClass("hidden", "md:block", "lg:col-start-2");
    expect(screen.getAllByTestId("rail-photo")).toHaveLength(1);
  });

  it("moves keyboard focus to an indexed section", () => {
    render(<DetailSections sections={sections} rawData={{ id: "example" }} />);

    fireEvent.click(screen.getByRole("link", { name: "Story" }));
    expect(document.activeElement).toBe(document.getElementById("story"));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
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

    expect(screen.getByText("Product route ledger")).toBeInTheDocument();
    expect(
      screen.queryByTestId("generic-relationships"),
    ).not.toBeInTheDocument();
    expect(mocks.relationshipExplorer).not.toHaveBeenCalled();
    expect(mocks.relationshipRoute).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("generic-relationships")).toBeVisible();
    expect(screen.getAllByTestId("relationship-route-preview")).toHaveLength(1);
    expect(
      screen
        .getByTestId("relationship-route-preview")
        .compareDocumentPosition(screen.getByTestId("generic-relationships")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
    expect(mocks.relationshipExplorer).toHaveBeenCalledWith({
      entity: "vendor",
      sourceId: "VEN-EXAMPLE",
    });
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
