import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AiUsageTableStatus, UsageEntityLink } from "./ai-usage-page";

vi.mock("~/app/_components/EntityInlineLinkById", () => ({
  EntityInlineLinkById: ({ entityId }: { entityId: string }) => (
    <div data-testid="entity-link">{entityId}</div>
  ),
}));

describe("UsageEntityLink", () => {
  it("renders the fallback, not a link, when entityId is a raw uuid", () => {
    // AiUsage.entityId is recorded from queue/side-effect payloads that carry
    // private uuids — EntityInlineLinkById expects a public shortcode, and
    // sending a uuid across that boundary previously resolved nothing.
    render(
      <UsageEntityLink
        row={{
          entityType: "product",
          entityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        }}
      />,
    );

    expect(screen.queryByTestId("entity-link")).not.toBeInTheDocument();
    expect(screen.getByText(/^product · 3fa85f64/)).toBeInTheDocument();
  });

  it("renders the link when entityId is a shortcode matching entityType", () => {
    render(
      <UsageEntityLink row={{ entityType: "product", entityId: "PRD-4K7M" }} />,
    );

    expect(screen.getByTestId("entity-link")).toHaveTextContent("PRD-4K7M");
  });

  it("renders the fallback when the shortcode's type does not match entityType", () => {
    render(
      <UsageEntityLink row={{ entityType: "product", entityId: "LOC-4K7M" }} />,
    );

    expect(screen.queryByTestId("entity-link")).not.toBeInTheDocument();
  });
});

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
