import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LabelSheet } from "./label-sheet";
import { SHEET_LAYOUTS } from "./sheet-layouts";

describe("LabelSheet", () => {
  it("contains the fixed paper preview inside an explicit horizontal scroller", () => {
    render(
      <LabelSheet
        items={[]}
        layout={SHEET_LAYOUTS.pls134}
        onToggle={() => {}}
      />,
    );

    const preview = screen.getByRole("region", {
      name: "Label sheet preview",
    });
    expect(preview).toHaveClass("max-w-full", "overflow-x-auto");
    expect((preview.firstElementChild as HTMLElement).style.width).toBe(
      SHEET_LAYOUTS.pls134.sheetWidth,
    );
  });

  it("keeps the print-only sheet outside the interactive preview wrapper", () => {
    const { container } = render(
      <LabelSheet items={[]} layout={SHEET_LAYOUTS.pls763} printOnly />,
    );

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("label-sheet", "hidden");
  });
});
