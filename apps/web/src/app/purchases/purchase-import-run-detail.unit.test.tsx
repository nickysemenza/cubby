import type { ImportRunOut } from "@cubby/schemas/import-run";
import { render, screen, within } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importRunDetailResponse,
  type ImportRunDetail,
} from "~/lib/purchase-import-run-detail";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RunImportWorkflow } from "./purchase-import-run-detail";

let harness: ReturnType<typeof createBrowserTestHarness>;
let detailRun: ImportRunDetail;

const run = {
  publicId: "RUN-4K7M",
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
  predecessorRunPublicId: null,
  coordinatorModel: "test-model",
  skillRevision: "purchase-import@test",
  runtimeRevision: "flue@test",
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
  detailRun = importRunDetailResponse.parse({ run }).run;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/agent")) {
        return Promise.resolve(
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
        );
      }
      if (url.includes("/run-logs")) {
        return Promise.resolve(
          new Response(JSON.stringify({ entries: [], truncated: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ run: detailRun }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
});

afterEach(() => {
  harness.dispose();
  vi.unstubAllGlobals();
});

const record = fromPartial<ImportRunOut>({
  id: run.publicId,
  status: "completed",
  purpose: "purchase_validation",
});

describe("RunImportWorkflow", () => {
  it("links image shortcodes in progress summaries and history", async () => {
    const update = {
      eventId: "progress-1",
      phase: "investigating",
      currentItem: "IMG-4S9Q + IMG-R6MW",
      awaitingApproval: false,
      detail: "Checking both label photos.",
      createdAt: "2026-09-20T16:02:00.000Z",
    };
    detailRun = importRunDetailResponse.parse({
      run: {
        ...run,
        progress: [update],
        latestProgress: { ...update, detail: "Review IMG-4S9Q." },
      },
    }).run;
    render(<RunImportWorkflow record={record} />, {
      wrapper: harness.wrapper,
    });

    const history = await screen.findByLabelText("Run progress history");
    expect(
      within(history).getByRole("link", { name: "IMG-4S9Q" }),
    ).toHaveAttribute("href", "/images/IMG-4S9Q");
    expect(
      within(history).getByRole("link", { name: "IMG-R6MW" }),
    ).toHaveAttribute("href", "/images/IMG-R6MW");
    expect(screen.getAllByRole("link", { name: "IMG-4S9Q" })).toHaveLength(2);
  });
  it("keeps terminal evidence view-only while showing the transcript", async () => {
    render(<RunImportWorkflow record={record} />, {
      wrapper: harness.wrapper,
    });

    expect(
      await screen.findByRole("link", { name: "Fixture purchase" }),
    ).toHaveAttribute("href", "/purchases/PUR-ABCDE12345");
    expect(
      screen.getByLabelText("Purchase import transcript"),
    ).toHaveTextContent("extract-1");
    expect(screen.getByText("Orders seen")).toBeInTheDocument();
    expect(screen.getByText("Targets and outcome")).toBeInTheDocument();
    expect(screen.getByText("Outcome: replayed")).toBeInTheDocument();
    expect(screen.getByText("fixture-order.pdf")).toBeInTheDocument();
    expect(await screen.findByText("System and Mac log")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry import" }),
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
