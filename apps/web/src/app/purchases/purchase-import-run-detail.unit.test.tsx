import { runShortcode } from "@cubby/schemas/identifiers";
import type {
  ApplyValidationCorrectionsOut,
  ValidationDiff,
} from "@cubby/schemas/purchase-import";
import type { RunOut } from "@cubby/schemas/run";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunDetail } from "~/contracts/run.contract";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  RunImportAgentActive,
  RunImportAgentStopped,
  RunImportControls,
  RunImportTargets,
  RunPhotoBatch,
} from "./purchase-import-run-detail";

let harness: ReturnType<typeof createBrowserTestHarness>;
let detailRun: RunDetail;
let applyResponse: ApplyValidationCorrectionsOut;
let restoreDispatch: () => void;
const operationCalls: Array<{ operation: string; input: unknown }> = [];

const run: RunDetail = {
  publicId: runShortcode.parse("RUN-4K7M"),
  status: "completed",
  purpose: "purchase_validation",
  trigger: "manual",
  startedAt: "2026-09-20T16:00:00.000Z",
  endedAt: "2026-09-20T16:03:00.000Z",
  ordersSeen: 3,
  imported: 1,
  updated: 1,
  skipped: 1,
  failureCode: null,
  notes: null,
  predecessorRunPublicId: null,
  restartInputs: null,
  successorRunPublicId: null,
  coordinatorModel: "test-model",
  skillRevision: "purchase-import@test",
  runtimeRevision: "flue@test",
  agentModelMs: 3_200,
  source: { kind: "vendor export", vendorName: "Fixture vendor" },
  actor: {
    name: "Fixture member",
    ledgerParty: { id: "LPY-ABCDE12345", name: "Fixture household" },
  },
  vendorAccount: { id: "account-1", label: "Fixture vendor" },
  affectedPurchases: [
    {
      shortcode: "PUR-ABCDE12345",
      displayName: "Fixture purchase",
      orderId: "fixture-order",
    },
  ],
  findings: [],
  controllingMembers: [],
  controlHistory: [],
  operations: [
    {
      operationId: "extract-1",
      kind: "extract",
      state: "completed",
      startedAt: "2026-09-20T16:01:00.000Z",
      completedAt: "2026-09-20T16:01:01.000Z",
      error: null,
    },
  ],
  preparedOrders: [],
  targets: [
    {
      id: "target-1",
      targetType: "purchase",
      targetShortcode: "PUR-ABCDE12345",
      targetName: "Fixture purchase",
      sourceId: null,
      sourceLabel: "browser order · fixture-order",
      vendorAccountLabel: "Fixture vendor",
      state: "completed",
      fingerprint: "fixture-fingerprint",
      outcome: "replayed",
      warning: null,
      diff: null,
      completedAt: "2026-09-20T16:03:00.000Z",
    },
  ],
  evidence: [
    {
      id: "evidence-1",
      targetId: null,
      sourceKind: "browser_capture",
      filename: "fixture-order.pdf",
      mediaType: "application/pdf",
      checksum: "fixture-checksum",
      createdAt: "2026-09-20T16:00:00.000Z",
    },
  ],
  dispatch: {
    eventId: "event-1",
    state: "started",
    attempts: 1,
    error: null,
    coordinatorStartedAt: "2026-09-20T16:00:01.000Z",
  },
  progress: [],
  latestProgress: null,
  approvals: [],
};

beforeEach(() => {
  harness = createBrowserTestHarness();
  detailRun = run;
  operationCalls.length = 0;
  restoreDispatch = overrideStartDispatch(async (operation, input) => {
    operationCalls.push({ operation, input });
    if (operation === "run.work") return { ok: true, data: detailRun };
    // The transcript and system log are server-composed report slots.
    if (operation === "entityReport.getMany")
      return {
        ok: true,
        data: {
          // SAFETY: the test controls the input shape it sends.
          reports: (input as { slots: string[] }).slots.map((slot) => ({
            slot,
            report: {
              live: false,
              status: detailRun.status,
              blocks:
                slot === "run.import-timeline"
                  ? [
                      {
                        kind: "records",
                        empty: "",
                        rows: detailRun.operations.map((operation) => ({
                          entity: null,
                          id: null,
                          title: operation.kind,
                          subtitle: null,
                          trailing: null,
                          key: operation.operationId,
                          at: operation.startedAt,
                          lines: [
                            { text: operation.operationId, tone: "muted" },
                          ],
                        })),
                      },
                    ]
                  : [],
            },
          })),
        },
      };
    if (operation === "entityReport.get")
      return {
        ok: true,
        data: {
          live: false,
          status: detailRun.status,
          blocks: [{ kind: "note", text: "No structured log entries." }],
        },
      };
    if (operation === "run.control")
      return { ok: true, data: { run: detailRun, successor: null } };
    if (operation === "purchaseImport.applyValidationCorrections")
      return { ok: true, data: applyResponse };
    if (operation === "photoImport.review")
      return {
        ok: true,
        data: {
          review: {
            runId: run.publicId,
            runStatus: "completed",
            proposals: [],
            unassignedImageIds: [],
          },
          images: [],
        },
      };
    throw new Error(`Unexpected operation: ${operation}`);
  });
  // The agent conversation stream stays a plain route.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            v: 1,
            conversationId: "agent-1",
            offset: "0",
            messages: [],
            settlements: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ),
  );
});

afterEach(() => {
  restoreDispatch();
  harness.dispose();
  vi.unstubAllGlobals();
});

const record = fromPartial<RunOut>({
  id: run.publicId,
  status: "completed",
  purpose: "purchase_validation",
});

// The generic detail page mounts these in the order the Run declaration lists
// them; each gates its own visibility, so together they are the whole workflow.
function RunImportSlots({ record }: { record: RunOut }) {
  return (
    <>
      <RunImportControls record={record} />
      <RunImportAgentActive record={record} />
      <RunImportTargets record={record} />
      <RunImportAgentStopped record={record} />
    </>
  );
}

describe("import run slots", () => {
  it("gives a paused retailer run one clear sign-in handoff and resume action", async () => {
    detailRun = { ...run, status: "paused_auth", endedAt: null };
    render(
      <RunImportSlots
        record={fromPartial<RunOut>({ ...record, status: "paused_auth" })}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByText("Sign in to Fixture vendor"),
    ).toBeInTheDocument();
    expect(screen.getByText(/managed browser tab/)).toBeInTheDocument();
    // A live run shows the live agent and none of the stopped-run history.
    expect(
      screen.getByRole("button", { name: "Send prompt" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/This terminal run is view-only/),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "I've signed in — resume run" }),
    );
    await waitFor(() =>
      expect(operationCalls).toContainEqual({
        operation: "run.control",
        input: { runId: "RUN-4K7M", action: "resume" },
      }),
    );
  });

  it("keeps terminal evidence view-only while showing the transcript", async () => {
    render(<RunImportSlots record={record} />, {
      wrapper: harness.wrapper,
    });

    expect(
      await screen.findByText(
        "The selected source and target are frozen for this run.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Outcome: replayed")).toBeInTheDocument();
    expect(
      await screen.findByText(/This terminal run is view-only/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry unresolved work" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start new run with same inputs" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Terra|Escalate to Sol/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send prompt" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Abort agent" }),
    ).not.toBeInTheDocument();
  });
});

describe("validation corrections review", () => {
  const correction = (
    id: string,
    field: ValidationDiff["corrections"][number]["field"],
    before: ValidationDiff["corrections"][number]["before"],
    after: ValidationDiff["corrections"][number]["after"],
  ): ValidationDiff["corrections"][number] => ({
    id,
    kind: "expense_field",
    target: { kind: "expense", code: fromPartial("EXP-2A3B") },
    field,
    before,
    after,
    fingerprint: "a".repeat(64),
  });
  const validationDiff: ValidationDiff = {
    version: 2,
    expected: {
      orderId: "fixture-order",
      currency: "USD",
      statedTotal: 12,
      lines: [],
      writeBlockReason: null,
    },
    actual: {
      orderId: "fixture-order",
      currency: "USD",
      statedTotal: 10,
      lines: [],
    },
    corrections: [
      correction("expense:EXP-2A3B:amount", "amount", 10, 12),
      correction("expense:EXP-2A3B:title", "title", "Widget", "Widget pro"),
    ],
    notes: [
      {
        id: "note:expense:EXP-2A3B:productId",
        target: { kind: "expense", code: fromPartial("EXP-2A3B") },
        field: "productId",
        before: "PRD-4K7M",
        after: "PRD-5K8N",
        message:
          "This line has an explicit Product assignment, which validation keeps.",
      },
    ],
    rawEvidenceDrift: false,
  };

  beforeEach(() => {
    applyResponse = {
      status: "applied",
      runId: run.publicId,
      purchaseId: fromPartial("PUR-4K7M"),
      operationId: "ignored",
      applied: ["expense:EXP-2A3B:amount"],
      outcome: "semantic_drift",
      remainingCorrections: 1,
    };
    detailRun = {
      ...run,
      targets: [
        {
          ...run.targets[0]!,
          targetShortcode: "PUR-4K7M",
          state: "unresolved",
          outcome: "semantic_drift",
          diff: validationDiff,
        },
      ],
    };
  });

  it("shows a before/after row per correction, an unselectable note, and applies only the checked set", async () => {
    render(<RunImportTargets record={record} />, {
      wrapper: harness.wrapper,
    });

    const amountRow = (await screen.findByText("amount")).closest("tr")!;
    expect(within(amountRow).getByText("$10.00")).toBeInTheDocument();
    expect(within(amountRow).getByText("$12.00")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes)
      expect(box).toHaveAttribute("aria-checked", "true");
    const noteRow = screen
      .getByText(/explicit Product assignment/)
      .closest("tr")!;
    expect(within(noteRow).queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.click(
      within(screen.getByText("title").closest("tr")!).getByRole("checkbox"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Apply 1 selected correction" }),
    );
    await waitFor(() =>
      expect(
        operationCalls.find(
          (call) =>
            call.operation === "purchaseImport.applyValidationCorrections",
        )?.input,
      ).toMatchObject({
        runId: "RUN-4K7M",
        purchaseId: "PUR-4K7M",
        correctionIds: ["expense:EXP-2A3B:amount"],
      }),
    );
  });

  it("shows the structured stale refusal inline with its raw diagnostic", async () => {
    applyResponse = {
      status: "stale",
      runId: run.publicId,
      purchaseId: fromPartial("PUR-4K7M"),
      stale: [
        {
          correctionId: "expense:EXP-2A3B:amount",
          reason: "fingerprint aaaa (reviewed) is now bbbb",
        },
      ],
    };
    render(<RunImportTargets record={record} />, {
      wrapper: harness.wrapper,
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Apply 2 selected corrections",
      }),
    );
    expect(
      await screen.findByText(/fingerprint aaaa \(reviewed\) is now bbbb/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument();
  });

  it("keeps a legacy diff readable as raw JSON", async () => {
    detailRun = {
      ...run,
      targets: [{ ...run.targets[0]!, diff: { expected: { lines: [] } } }],
    };
    render(<RunImportTargets record={record} />, {
      wrapper: harness.wrapper,
    });
    expect(
      await screen.findByText("Review semantic difference"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

it("shows durable progress and diagnostics alongside photo group review", async () => {
  detailRun = {
    ...run,
    purpose: "photo_inventory",
    targets: [],
    operations: [
      {
        operationId: "group-1",
        kind: "commit_photo_group",
        state: "completed",
        startedAt: "2026-09-20T16:01:00.000Z",
        completedAt: "2026-09-20T16:01:02.000Z",
        error: null,
      },
    ],
  };
  const photoRecord = fromPartial<RunOut>({
    id: run.publicId,
    status: "completed",
    purpose: "photo_inventory",
  });
  render(<RunPhotoBatch record={photoRecord} />, {
    wrapper: harness.wrapper,
  });

  expect(
    await screen.findByRole("heading", { name: "Photo review" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Run progress")).not.toBeInTheDocument();
  expect(screen.getByText("Timeline and system log")).toBeInTheDocument();
  expect(await screen.findByText("group-1")).toBeInTheDocument();
  expect(screen.getByText("System and Mac log")).toBeInTheDocument();
  expect(await screen.findByText("Work at a glance")).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Run step timing table" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Total run wall time")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Start new run with same inputs" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Photo review complete")).toBeInTheDocument();
  expect(screen.queryByText("Extracted order details")).not.toBeInTheDocument();
  expect(
    screen.getByText("Agent messages and tool calls · 0 messages"),
  ).toBeInTheDocument();
});

it("shows the remaining photo milestones while a run is active", async () => {
  detailRun = {
    ...run,
    purpose: "photo_inventory",
    status: "running",
    endedAt: null,
    targets: [],
    operations: [],
  };
  render(
    <RunPhotoBatch
      record={fromPartial<RunOut>({
        id: run.publicId,
        status: "running",
        purpose: "photo_inventory",
      })}
    />,
    { wrapper: harness.wrapper },
  );

  const table = await screen.findByRole("region", {
    name: "Run step timing table",
  });
  expect(table).toHaveTextContent("Read photos and analysis");
  expect(table).toHaveTextContent("Compare existing products");
  expect(table).toHaveTextContent("Propose item groups");
  expect(table).toHaveTextContent("Review proposed groups");
  expect(table).toHaveTextContent("Upcoming");
});
