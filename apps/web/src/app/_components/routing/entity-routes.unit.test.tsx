import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detailPage } from "./entity-routes";

const queryState = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("@tanstack/react-query", () => ({
  useSuspenseQuery: () => ({ data: queryState.data }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/records">{children}</a>
  ),
  notFound: () => new Error("record not found"),
  useParams: () => ({ shortcode: "PRD-TEST" }),
}));

vi.mock("~/hooks/useDocumentTitle", () => ({
  useDetailTitle: vi.fn(),
}));

describe("detailPage", () => {
  beforeEach(() => {
    queryState.data = null;
  });

  it("transitions a refetched missing record into route not-found", () => {
    const Detail = detailPage({
      query: () => ({ queryKey: ["record"] }),
      render: () => <div>record</div>,
      title: () => "Record",
    });

    expect(() => render(<Detail />)).toThrow("record not found");
  });
});
