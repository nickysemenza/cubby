import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entities/entity-query";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { AiUsageTableStatus, UsageEntityLink } from "./ai-usage-page";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function seedProduct(id: string, name: string) {
  const options = entityPreviewQueryOptions("product", id);
  harness.queryClient.setQueryDefaults(options.queryKey, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  harness.queryClient.setQueryData(options.queryKey, {
    id,
    name,
    displayImages: [],
  });
}

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
      { wrapper: harness.wrapper },
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/^product · 3fa85f64/)).toBeInTheDocument();
  });

  it("renders a real entity detail link for a matching public shortcode", () => {
    seedProduct("PRD-4K7M", "Fixture product");

    render(
      <UsageEntityLink row={{ entityType: "product", entityId: "PRD-4K7M" }} />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("link", { name: "Fixture product" }),
    ).toHaveAttribute("href", "/products/PRD-4K7M");
  });

  it("renders the fallback when the shortcode's type does not match entityType", () => {
    render(
      <UsageEntityLink row={{ entityType: "product", entityId: "LOC-4K7M" }} />,
      { wrapper: harness.wrapper },
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("AiUsageTableStatus", () => {
  it("keeps a failed query distinct from a valid empty result", () => {
    let retries = 0;
    render(
      <table>
        <tbody>
          <AiUsageTableStatus
            isLoading={false}
            error={new Error("usage unavailable")}
            isEmpty
            emptyLabel="No recent calls"
            retryLabel="Retry recent calls"
            onRetry={() => {
              retries += 1;
            }}
          />
        </tbody>
      </table>,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "AI usage data could not load.",
    );
    expect(screen.queryByText("No recent calls")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry recent calls" }));
    expect(retries).toBe(1);
  });
});
