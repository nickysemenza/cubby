import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrphanedClientMaintenance } from "./orphaned-client-maintenance";

describe("OrphanedClientMaintenance", () => {
  it("keeps a failed count distinct from a valid zero and retries", () => {
    const onRetry = vi.fn();
    render(
      <OrphanedClientMaintenance
        count={undefined}
        error={new Error("Count unavailable")}
        isCleaning={false}
        onCleanup={() => {}}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Count unavailable")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Retry abandoned registrations",
      }),
    );
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders nothing for a successfully loaded zero", () => {
    const { container } = render(
      <OrphanedClientMaintenance
        count={0}
        error={null}
        isCleaning={false}
        onCleanup={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
