import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeferredListValue } from "./deferred-list-value";

// Formatting omitted fields may invent a zero or a healthy status. Deferred
// content must not mount until its own group is ready, including after error.
describe("deferred list cells", () => {
  it("withholds content until ready and retains raw failure text", () => {
    const { rerender } = render(
      <DeferredListValue state={{ state: "loading" }}>
        Healthy · $0.00
      </DeferredListValue>,
    );
    expect(screen.queryByText("Healthy · $0.00")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Loading field")).toBeVisible();
    rerender(
      <DeferredListValue
        state={{ state: "error", error: "Synthetic lookup failure" }}
      >
        Healthy · $0.00
      </DeferredListValue>,
    );
    expect(screen.getByText("Unavailable")).toHaveAttribute(
      "title",
      "Synthetic lookup failure",
    );
    rerender(
      <DeferredListValue state={{ state: "ready" }}>
        Healthy · $0.00
      </DeferredListValue>,
    );
    expect(screen.getByText("Healthy · $0.00")).toBeVisible();
  });
});
