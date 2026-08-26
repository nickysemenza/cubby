import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiUsageTableStatus } from "./ai-usage-page";

describe("AiUsageTableStatus", () => {
  it("keeps a failed query distinct from a valid empty result", () => {
    const onRetry = vi.fn();
    render(
      <table>
        <tbody>
          <AiUsageTableStatus
            isLoading={false}
            error={new Error("usage unavailable")}
            isEmpty
            emptyLabel="No recent calls"
            retryLabel="Retry recent calls"
            onRetry={onRetry}
          />
        </tbody>
      </table>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "AI usage data could not load.",
    );
    expect(screen.queryByText("No recent calls")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry recent calls" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
