import { fireEvent, render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DetailSection, DetailSections } from "./detail-page";

const viewport = vi.hoisted(() => ({ isMobile: false }));

vi.mock("~/hooks/useMobile", () => ({
  useIsMobile: () => viewport.isMobile,
}));
vi.mock("~/hooks/useDebug", () => ({
  useDebug: () => ({ isDebugEnabled: false }),
}));
vi.mock("~/components/page/Page", () => ({
  usePageDetailContext: () => undefined,
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
    viewport.isMobile = false;
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("renders explicit desktop tracks and a ruled section index", () => {
    const { container } = render(
      <DetailSections sections={sections} rawData={{ id: "example" }} />,
    );

    expect(screen.getByText("Record index")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Story" })).toHaveAttribute(
      "href",
      "#story",
    );
    expect(
      container.querySelector("#story")?.parentElement?.parentElement,
    ).toHaveClass("lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]");
    expect(
      screen.getByRole("heading", { name: "Story", level: 2 }),
    ).toBeInTheDocument();
  });

  it("keeps authored source order in the phone column", () => {
    viewport.isMobile = true;
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
    expect(screen.queryByText("Record index")).not.toBeInTheDocument();
  });
});
