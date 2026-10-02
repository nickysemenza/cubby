import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderScalarValue } from "./scalar-value";

describe("structured scalar presentation", () => {
  const data = [{ source: "fixture", externalId: "ABC-123" }];

  it("summarizes compact values and reveals the full payload on demand", async () => {
    render(<>{renderScalarValue({ kind: "json", raw: data }, "list")}</>);
    expect(screen.getByRole("button", { name: /1 item/i })).toBeVisible();
    expect(screen.queryByText(/ABC-123/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 item/i }));
    expect(await screen.findByText(/ABC-123/)).toBeVisible();
  });

  it("collapses generic detail JSON until requested", () => {
    render(<>{renderScalarValue({ kind: "json", raw: data }, "detail")}</>);
    const disclosure = screen.getByText(/1 item/i).closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText(/1 item/i));
    expect(disclosure).toHaveAttribute("open");
    expect(disclosure).toHaveTextContent("ABC-123");
  });
});
