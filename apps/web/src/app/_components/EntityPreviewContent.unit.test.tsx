import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreviewQuery } from "./preview/preview-query";

describe("PreviewQuery", () => {
  it("renders loading, deleted, and success states", () => {
    const { rerender } = render(
      <PreviewQuery
        query={{ data: undefined, isLoading: true }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{ data: undefined, isLoading: false }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Product (deleted)")).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{ data: { name: "Olive oil" }, isLoading: false }}
        label="Product"
      >
        {(data) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Olive oil")).toBeInTheDocument();
  });
});
