import type { SuggestionReviewRow } from "@cubby/schemas/ai";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SuggestionRows } from "./suggestion-queue";

const row: SuggestionReviewRow = {
  id: "00000000-0000-4000-8000-000000000301",
  runId: "00000000-0000-4000-8000-000000000302",
  entity: "product",
  recordId: "00000000-0000-4000-8000-000000000303",
  field: "categoryId",
  currentValue: "old-category",
  suggestedValue: "new-category",
  confidence: 0.92,
  model: "typesafe/jev",
  kind: "correction",
  correctValue: null,
};

describe("SuggestionRows", () => {
  it("routes row accept and reject actions to their matching ids", () => {
    const accept = vi.fn();
    const reject = vi.fn();
    render(
      <SuggestionRows
        rows={[row]}
        selected={new Set()}
        setSelected={vi.fn()}
        accept={accept}
        reject={reject}
        busy={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(accept).toHaveBeenCalledWith(row.id);
    expect(reject).toHaveBeenCalledWith(row.id);
  });
});
