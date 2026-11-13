import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { runDetailContract } from "~/contracts/run-detail.contract";
import { entityReadFixture } from "~/entity/fields/field-envelope.fixtures";
import { runDetail } from "~/integrations/tanstack-query/generated/domains/runDetail.gen";
import { overrideOperationDispatch } from "~/integrations/tanstack-query/operation-call";
import type { OperationWireValue } from "~/lib/operation-result";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RunEvaluations } from "./run-evaluations";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

// SAFETY: the detail body reads only the Run's shortcode, status, purpose and selected input.
const run = entityReadFixture(entityFieldEnvelopeSchemas.run.detail, {
  id: "RUN-4K7M",
  status: "running",
  purpose: "sweep",
});

const answers = new Map<string, OperationWireValue>([
  [
    "runDetail.evaluations",
    {
      measuredAt: ago(0),
      pace: {
        windowMinutes: 5,
        completedPerMinute: 12,
        lastCompletedAt: ago(1),
      },
      roster: { walked: 80, total: 100 },
      byKind: [
        {
          entity: "product",
          feature: "entity-connections",
          featureLabel: "Connections",
          waiting: 22,
          completed: 60,
          failed: 2,
          obsolete: 1,
          cancelled: 0,
        },
      ],
      recent: [],
    },
  ],
]);

let harness: ReturnType<typeof createBrowserTestHarness>;
let restore: (() => void) | undefined;

beforeEach(async () => {
  await page.viewport(1440, 1200);
  harness = createBrowserTestHarness();
  restore = overrideOperationDispatch(async (operation) => {
    const data = answers.get(operation);
    if (data === undefined) throw new Error(`${operation} is not stubbed`);
    return { ok: true, data };
  });
});

afterEach(() => {
  restore?.();
  harness.dispose();
});

it.each(["paused", "failed"] as const)(
  "keeps evaluation counts without a rate for a %s Run",
  async (status) => {
    render(<RunEvaluations record={{ ...run, status }} />, {
      wrapper: harness.wrapper,
    });
    const progress = await screen.findByTestId("run-evaluations");
    expect(
      within(progress).getByText("Records checked: 80 of 100"),
    ).toBeVisible();
    expect(
      within(progress).getByText(/^Evaluations settled: 63 of 85/),
    ).toBeVisible();
    expect(progress).not.toHaveTextContent("/min");
    expect(progress).not.toHaveTextContent("left for what is queued");
  },
);

it("ages a successful evaluation read while offline and removes live pace and ETA", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    render(<RunEvaluations record={run} />, { wrapper: harness.wrapper });
    const progress = await screen.findByTestId("run-evaluations");
    expect(progress).toHaveTextContent("12/min");
    onlineManager.setOnline(false);
    await act(async () => {
      clock.mockReturnValue(NOW + 120_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(progress.textContent).toMatch(/Data.*2 min.*ago/);
    expect(progress).not.toHaveTextContent("/min");
    expect(progress).not.toHaveTextContent("left for what is queued");
    expect(progress).not.toHaveTextContent("Not moving right now");
  } finally {
    clock.mockRestore();
    onlineManager.setOnline(true);
  }
});

it("retains cancelled evaluations in the stopped Run population", async () => {
  const data = runDetailContract.ops.evaluations.output.parse(
    answers.get("runDetail.evaluations"),
  );
  harness.queryClient.setQueryData(
    runDetail.evaluations.queryKey({ runId: run.id, failedOnly: false }),
    {
      ...data,
      byKind: data.byKind.map((kind) => ({
        ...kind,
        completed: 20,
        waiting: 0,
        failed: 0,
        obsolete: 0,
        cancelled: 80,
      })),
    },
  );
  render(<RunEvaluations record={{ ...run, status: "failed" }} />, {
    wrapper: harness.wrapper,
  });
  const progress = await screen.findByTestId("run-evaluations");
  expect(
    within(progress).getByText("Evaluations settled: 20 of 100"),
  ).toBeVisible();
  expect(progress).toHaveTextContent("80 cancelled");
  expect(
    within(progress).getByRole("columnheader", { name: "Cancelled" }),
  ).toBeVisible();
});
