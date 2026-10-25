import type { RunOut } from "@cubby/schemas/run";
import {
  type transferPairLeg,
  transferPairJudgment,
} from "@cubby/schemas/transfer-pair-suggestion";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { z } from "zod";

import type { JobListOut, JobLogsOut } from "~/contracts/job.contract";
import type {
  RunDecisionsOut,
  RunDetailStepsOut,
} from "~/contracts/run-detail.contract";
import { runDetail } from "~/integrations/tanstack-query/generated/catalog/runDetail.gen";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import type { UnparsedStartOperationData } from "~/server/operation-runtime/start-operation.contract";

import { RunDecisions, RunDiagnostics, RunStepsDetail } from "./run-detail";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

// SAFETY: the detail body reads only the Run's shortcode, status, purpose and selected input.
const run = {
  id: "RUN-4K7M",
  status: "running",
  purpose: "sweep",
} as RunOut;

const step = (
  key: string,
  position: number,
  patch: Partial<RunDetailStepsOut["steps"][number]>,
): RunDetailStepsOut["steps"][number] => ({
  key,
  label: key,
  position,
  state: "queued",
  found: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  left: 0,
  pages: 0,
  pausedReason: null,
  pausedUntil: null,
  startedAt: null,
  endedAt: null,
  errors: [],
  meta: null,
  ...patch,
});

const steps: RunDetailStepsOut = {
  input: {
    kind: "sweep",
    families: [
      { family: "transfer_pair", scope: {} },
      { family: "statement_transaction", scope: {} },
    ],
  },
  purpose: "sweep",
  status: "running",
  steps: [
    step("orphans", 1, {
      label: "Orphan cleanup",
      state: "done",
      found: 40,
      done: 40,
      pages: 1,
      startedAt: ago(30),
      endedAt: ago(28),
    }),
    step("transfer_pair_scan", 2, {
      label: "Transfer pairs: scan",
      state: "running",
      found: 1_200,
      done: 300,
      skipped: 60,
      // 1,200 − 300 done − 60 skipped − 12 removed.
      left: 828,
      pages: 3,
      startedAt: ago(20),
      meta: {
        input: {
          mode: "count",
          total: 1_200,
          boundary: "posted before Mar 2",
          countedAt: ago(20),
        },
        tallies: { published: 2, removed: 12 },
        reasons: { no_candidate: 240, not_transfer_like: 108 },
        timing: { lastPageMs: 10_000, totalMs: 30_000 },
        page: {
          timings: { selection: 1_000, preparation: 6_100, publication: 2_900 },
          queries: 106,
          concurrency: { publication: 1 },
        },
      },
    }),
    step("statement_generate", 3, { label: "Statements: generate" }),
  ],
};

type LegInput = z.input<typeof transferPairLeg>;
const leg = (side: "out" | "in", patch: Partial<LegInput>): LegInput => ({
  key: `ftx:FTX-4K7${side === "out" ? "M" : "N"}`,
  origin: "transaction",
  accountId: side === "out" ? "FAC-4K7M" : "FAC-2222",
  accountName: side === "out" ? "Checking ••01" : "Savings ••07",
  accountKind: "bank_account",
  owner: { id: "LPY-4K7M", name: "Member A" },
  transactionId: side === "out" ? "FTX-4K7M" : "FTX-ABCD",
  charge: null,
  amount: side === "out" ? 250 : -250,
  date: "2026-02-03",
  merchant: null,
  description: "Synthetic transfer",
  kind: "account_transfer",
  signals: { kind: "account_transfer", providerCategory: null },
  movementLabel: null,
  movement: "explicit",
  refs: [],
  overlaps: [],
  ...patch,
});
const judgment = (patch: Partial<z.input<typeof transferPairJudgment>>) =>
  transferPairJudgment.parse({
    key: "ftx:FTX-4K7M~ftx:FTX-ABCD",
    outflow: leg("out", {}),
    inflow: leg("in", {}),
    amount: 250,
    date: "2026-02-03",
    dateGapDays: 0,
    move: "internal",
    competitors: [],
    blockers: [],
    reasons: [],
    clean: true,
    apply: { available: true, reason: null },
    ...patch,
  });
const decisions: RunDecisionsOut = {
  total: 2,
  rows: [
    {
      id: "00000000-0000-4000-8000-0000000000a1",
      family: "transfer_pair",
      status: "applied",
      active: true,
      judgment: judgment({}),
      producer: { kind: "sweep", model: null, revision: "r1" },
      createdAt: ago(10),
      updatedAt: ago(9),
    },
    {
      id: "00000000-0000-4000-8000-0000000000b2",
      family: "transfer_pair",
      status: "pending",
      active: true,
      judgment: judgment({
        inflow: leg("in", {
          accountName: "Brokerage ••15",
          owner: { id: "LPY-4K7N", name: "Member B" },
        }),
        move: "between_owners",
        blockers: ["owners_differ"],
        reasons: ["The accounts belong to different people."],
        clean: false,
      }),
      producer: { kind: "sweep", model: null, revision: "r1" },
      createdAt: ago(8),
      updatedAt: ago(8),
    },
  ],
};

const jobs: JobListOut = {
  primary: {
    id: "00000000-0000-4000-8000-0000000000c3",
    key: "run:RUN-4K7M",
    kind: "run.execute",
    state: "running",
    generation: 4,
    attempts: 1,
    maxAttempts: 3,
    priority: 0,
    waitReason: null,
    waitUntil: null,
    availableAt: ago(20),
    leaseExpiresAt: ago(-4),
    error: null,
    cursor: null,
    subject: null,
    createdAt: ago(20),
    updatedAt: ago(0),
    ahead: null,
    lane: "server",
    waitingOn: {
      reason: "leased",
      lane: "server",
      executor: "Cubby server",
      executorDeviceId: null,
      leasedAt: ago(1),
      leaseExpiresAt: ago(-4),
      expired: false,
    },
    runId: null,
  },
  groups: [],
  limits: [],
  binding: {
    status: "binding",
    key: null,
    label: "Page work",
    evidence: "preparation 61% of page time · 106 queries/page",
  },
  rollup: null,
};

const logs: JobLogsOut = {
  status: "not_configured",
  dashboardUrl: "https://dash.cloudflare.com/",
};

const answers = new Map<string, UnparsedStartOperationData>([
  ["runDetail.steps", steps],
  ["runDetail.decisions", decisions],
  ["job.list", jobs],
  ["job.logs", logs],
]);

let harness: ReturnType<typeof createBrowserTestHarness>;
let restore: (() => void) | undefined;

beforeEach(async () => {
  await page.viewport(1440, 1200);
  harness = createBrowserTestHarness();
  restore = overrideStartDispatch(async (operation) => {
    const data = answers.get(operation);
    if (data === undefined) throw new Error(`${operation} is not stubbed`);
    return { ok: true, data };
  });
});

/** The three Run slots, as the detail page renders them. */
const renderRun = () =>
  render(
    <>
      <RunStepsDetail record={run} />
      <RunDecisions record={run} />
      <RunDiagnostics record={run} />
    </>,
    { wrapper: harness.wrapper },
  );

afterEach(() => {
  restore?.();
  harness.dispose();
});

it("shows each step's own count, what sets its speed, and steps not yet counted", async () => {
  renderRun();
  const strip = await screen.findByTestId("run-step-strip");
  expect(strip).toHaveTextContent("Step 1 of 6");
  expect(strip).toHaveTextContent("no overall percentage");
  expect(strip).toHaveTextContent("Overall ETA: Unknown");
  expect(screen.getByText("Historical steps")).toBeVisible();

  const current = screen.getByTestId("run-step-transfer_pair_scan");
  // 300 done + 60 skipped + 12 removed of the frozen 1,200.
  expect(within(current).getByText("31%")).toBeVisible();
  expect(within(current).getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "372",
  );
  expect(within(current).getByTestId("speed-set-by")).toHaveTextContent(
    "Speed set by page work: preparation 61% of page time · 106 queries/page",
  );
  expect(within(current).getByTestId("page-work")).toHaveTextContent(
    "106 queries/page",
  );
  expect(within(current).getByText("No candidate")).toBeVisible();

  const later = screen.getByTestId("run-step-statement_generate");
  expect(
    within(later).getByText("Counts its inputs when it starts."),
  ).toBeVisible();
  expect(within(later).queryByRole("progressbar")).toBeNull();

  await expect
    .element(page.getByText("Inline logs aren't configured"))
    .toBeVisible();
});

it.each([1440, 402])(
  "filters the shared ledger and opens evidence at width %s",
  async (width) => {
    await page.viewport(width, 1200);
    renderRun();
    const ledger = await screen.findByTestId("decision-ledger");
    expect(await within(ledger).findByText("2 of 2 decisions")).toBeVisible();
    expect(
      screen.queryByRole("complementary", { name: "Decision evidence" }),
    ).toBeNull();

    await userEvent.click(
      await within(screen.getByTestId("run-step-strip")).findByRole("button", {
        name: /needs review/i,
      }),
    );
    expect(await within(ledger).findByText("1 of 2 decisions")).toBeVisible();
    const row =
      width >= 768
        ? within(ledger).getByRole("row", { name: /Brokerage/ })
        : within(ledger).getByRole("button", { name: /Brokerage/ });
    if (width >= 768) await userEvent.click(row);
    else {
      row.focus();
      await userEvent.keyboard("{Enter}");
    }
    const drawer = await screen.findByRole("complementary", {
      name: "Decision evidence",
    });
    await waitFor(() =>
      expect(
        within(drawer).getByText("Transfers create no Expenses."),
      ).toBeVisible(),
    );
    expect(
      within(drawer).getAllByText(/The account owners differ/)[0],
    ).toBeVisible();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Raw diagnostics" }),
    );
    expect(within(drawer).getByText(/"owners_differ"/)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Decision evidence" }),
      ).toBeNull(),
    );
    await userEvent.click(
      within(ledger).getByRole("button", { name: "Clear Status filter" }),
    );
    expect(await within(ledger).findByText("2 of 2 decisions")).toBeVisible();
  },
);

it("keeps earlier decision families available inside the Run", async () => {
  renderRun();
  const picker = await screen.findByRole("combobox", {
    name: "Decision family",
  });
  await userEvent.click(picker);
  await userEvent.click(
    await screen.findByRole("option", {
      name: /statement.*transaction.*assessments/i,
    }),
  );
  await waitFor(() =>
    expect(
      harness.queryClient.getQueryData(
        runDetail.decisions.queryKey({
          runId: run.id,
          family: "statement_transaction",
        }),
      ),
    ).toBeDefined(),
  );
  await userEvent.click(picker);
  await userEvent.click(
    await screen.findByRole("option", { name: /transfer candidates/i }),
  );
});
