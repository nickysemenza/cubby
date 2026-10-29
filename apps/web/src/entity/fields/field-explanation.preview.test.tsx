import {
  fieldExplanationInput,
  fieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import { mock } from "~/lib/test/mock-schema";
import { WhyValue } from "~/ui/derived/why-value";

let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
let restoreTransport: (() => void) | undefined;
afterEach(() => {
  restoreTransport?.();
  restoreTransport = undefined;
  harness?.dispose();
  harness = undefined;
});

const productId = testShortcode("product", "PRD-4K7M");
const vendorId = testShortcode("vendor", "VEN-4K7M");
const evidenceUrl = `https://supplier.example/catalog/${"synthetic-".repeat(30)}item`;
const explanation = mock(fieldExplanationOutput, {
  overrides: {
    subject: { entityKind: "product", entityId: productId },
    field: "dataQuality",
    label: "Quality",
    envelope: {
      current: {
        assignment: null,
        controls: { kind: "readonly", reason: "computed" },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: 80 },
          provenance: { kind: "computed" },
        },
      },
      work: { kind: "idle" },
    },
    evaluatedAt: "2026-09-01T12:00:00Z",
    rule: {
      id: "product.data-quality",
      revision: 1,
      description: "Synthetic weighted quality",
    },
    interpretation: undefined,
    resolutionEvidence: null,
    qualityBreakdown: {
      score: 80,
      status: "needs_data",
      weightedScore: 80,
      scoreCap: null,
      expectedWeight: 5,
      satisfiedWeight: 4,
      summary: "4 of 5 weighted checks satisfied",
      checks: [],
    },
    truncated: true,
    actions: [],
    sources: Array.from({ length: 8 }, (_, index) => ({
      label: `Synthetic evidence ${index + 1}`,
      entity: null,
      value:
        index === 0
          ? {
              amount: -159.84,
              source: { id: vendorId, name: "Synthetic evidence supplier" },
              url: evidenceUrl,
              date: "2022-03-11T12:00:00Z",
              note: "Synthetic long evidence remains readable inside the viewport.",
            }
          : { note: "Synthetic supporting evidence", amount: -159.84 },
    })),
  },
});

// The real operation/query/popover components own this state machine once.
// Server evidence selection and exception writes remain real HTTP/PG/E2E contracts.
it("loads on demand, retries a failed read and expands bounded evidence without losing phone focus", async () => {
  await page.viewport(402, 874);
  harness = createBrowserTestHarness();
  let releaseFailure = () => {};
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  const calls: unknown[] = [];
  restoreTransport = overrideOperationDispatch(async (operation, input) => {
    if (operation !== "fieldExplanation.explain")
      throw new Error(`Unexpected operation ${operation}`);
    calls.push(input);
    if (calls.length === 1) {
      await failureGate;
      throw new Error("Synthetic explanation temporarily unavailable");
    }
    return { ok: true, data: explanation };
  });
  render(
    <WhyValue
      entity="product"
      id={productId}
      field="dataQuality"
      label="Quality"
      surface="summary"
    />,
    { wrapper: harness.wrapper },
  );
  const trigger = screen.getByRole("button", {
    name: "How quality is determined",
  });
  expect(calls).toHaveLength(0);
  await userEvent.click(trigger);
  await waitFor(() => expect(screen.getByText("Loading…")).toBeVisible());
  releaseFailure();
  const retry = await screen.findByRole("button", {
    name: "Retry explanation",
  });
  expect(
    screen.getByText(/Synthetic explanation temporarily unavailable/),
  ).toBeVisible();
  await userEvent.click(retry);
  await waitFor(() =>
    expect(screen.getByText("Score calculation")).toBeVisible(),
  );
  expect(screen.queryByText("Synthetic evidence 8")).not.toBeInTheDocument();
  await userEvent.click(screen.getByText("Show 2 more evidence entries"));
  expect(await screen.findByText("Synthetic evidence 8")).toBeVisible();
  const panel = screen.getByRole("dialog");
  expect(panel).toHaveTextContent("not an exhaustive list");
  expect(panel).toHaveTextContent("-$159.84");
  expect(
    within(panel).getByRole("link", { name: "Synthetic evidence supplier" }),
  ).toHaveAttribute("href", `/vendors/${vendorId}`);
  expect(
    within(panel).getByRole("link", { name: /supplier.example\/catalog/ }),
  ).toHaveAttribute("href", evidenceUrl);
  const date = panel.querySelector('time[datetime="2022-03-11T12:00:00.000Z"]');
  expect(date).toBeVisible();
  expect(date).toHaveTextContent("Mar 11");
  expect(date).not.toHaveTextContent("T00:");
  await waitFor(() => {
    const bounds = panel.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(874);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
  expect(calls).toEqual([
    {
      entityKind: "product",
      entityId: productId,
      field: "dataQuality",
      surface: "summary",
    },
    {
      entityKind: "product",
      entityId: productId,
      field: "dataQuality",
      surface: "summary",
    },
  ]);
});

it("compares the displayed publication with current inputs only after an explicit diagnostic", async () => {
  harness = createBrowserTestHarness();
  const displayedResult = {
    kind: "cached" as const,
    decision: {
      outcome: { kind: "value" as const, value: 18 },
      provenance: { kind: "computed" as const },
    },
    computedAt: "2026-10-25T12:00:00Z",
  };
  const envelope = fieldExplanationOutput.shape.envelope.parse({
    ...explanation.envelope,
    result: {
      ...displayedResult,
      freshness: "stale",
    },
    work: { kind: "pending" },
  });
  const calls: unknown[] = [];
  restoreTransport = overrideOperationDispatch(async (_operation, input) => {
    const request = fieldExplanationInput.parse(input);
    calls.push(request);
    return {
      ok: true,
      data: {
        ...explanation,
        qualityBreakdown: undefined,
        sources: [],
        envelope,
        comparison: request.diagnostic
          ? {
              kind: "available",
              result: {
                kind: "live",
                decision: {
                  outcome: { kind: "value", value: 24 },
                  provenance: { kind: "computed" },
                },
              },
            }
          : {
              kind: "unavailable",
              reason: "Live diagnostic has not been requested",
            },
      },
    };
  });
  render(
    <WhyValue
      entity="product"
      id={productId}
      field="price"
      label="Price"
      surface="list"
      resolution={envelope}
    />,
    { wrapper: harness.wrapper },
  );
  await userEvent.click(
    screen.getByRole("button", { name: "How price is determined" }),
  );
  const diagnostic = await screen.findByRole("button", {
    name: "Compare with current inputs",
  });
  expect(screen.queryByText("24")).not.toBeInTheDocument();
  expect(calls).toEqual([expect.objectContaining({ displayedResult })]);
  expect(fieldExplanationInput.parse(calls[0]).diagnostic).toBeUndefined();
  await userEvent.click(diagnostic);
  await waitFor(() => expect(screen.getByText("24")).toBeVisible());
  expect(fieldExplanationInput.parse(calls.at(-1)).diagnostic).toBe(true);
  expect(screen.getByRole("dialog")).toHaveTextContent("Stored 18 → live 24");
  expect(screen.getByLabelText("Updating")).toBeVisible();
});
