import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entity/entity-query";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { aiUsageSummaryRowId, UsageEntityLink } from "./ai-usage-page";

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
    // private uuids — EntityRefLink (byId) expects a public shortcode, and
    // sending a uuid across that boundary previously resolved nothing.
    render(
      <UsageEntityLink
        row={{
          entityKind: "product",
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
      <UsageEntityLink row={{ entityKind: "product", entityId: "PRD-4K7M" }} />,
      { wrapper: harness.wrapper },
    );

    expect(
      screen.getByRole("link", { name: "Fixture product" }),
    ).toHaveAttribute("href", "/products/PRD-4K7M");
  });

  it("renders the fallback when the shortcode's type does not match entityKind", () => {
    render(
      <UsageEntityLink row={{ entityKind: "product", entityId: "LOC-4K7M" }} />,
      { wrapper: harness.wrapper },
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

it("keeps distinct SQL job groups separate in the table row model", () => {
  const common = {
    day: "2026-01-01",
    feature: "synthetic",
    provider: "openai",
    model: "gpt-6-luna",
    transport: "gateway",
    operation: "synthetic.generate",
    jobKind: "synthetic-job",
    cacheStatus: null,
    applicationCacheStatus: null,
  } satisfies Omit<Parameters<typeof aiUsageSummaryRowId>[0], "jobId">;
  const ids = ["synthetic-first-job", "synthetic-second-job"].map((jobId) =>
    aiUsageSummaryRowId({ ...common, jobId }),
  );
  expect(new Set(ids).size).toBe(2);
});
