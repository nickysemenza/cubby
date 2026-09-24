import type { ImportRunOut } from "@cubby/schemas/import-run";
import { render, screen } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { RunImportWorkflow, RunPhotoBatch } from "./purchase-import-run-detail";

let harness: ReturnType<typeof createBrowserTestHarness>;

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
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/photo-groups")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              review: {
                runId: run.publicId,
                runStatus: "completed",
                proposals: [],
                unassignedImageIds: [],
              },
              images: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
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
        new Response(JSON.stringify({ run }), {
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
  it("keeps terminal evidence view-only while showing the transcript", async () => {
    render(<RunImportWorkflow record={record} />, {
      wrapper: harness.wrapper,
    });

    expect(
      await screen.findByRole("link", { name: "Fixture purchase" }),
    ).toHaveAttribute("href", "/purchases/PUR-ABCDE12345");
    expect(screen.getByLabelText("Import run transcript")).toHaveTextContent(
      "extract-1",
    );
    expect(screen.getByText("Orders seen")).toBeInTheDocument();
    expect(screen.getByText("Targets and outcome")).toBeInTheDocument();
    expect(screen.getByText("Outcome: replayed")).toBeInTheDocument();
    expect(screen.getByText("fixture-order.pdf")).toBeInTheDocument();
    expect(await screen.findByText("System and Mac log")).toBeInTheDocument();
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

it("shows durable progress and diagnostics alongside photo group review", async () => {
  const defaultFetch = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith(`/api/import/runs/${run.publicId}`))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              run: {
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
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      return defaultFetch(input, init);
    }),
  );
  const photoRecord = fromPartial<ImportRunOut>({
    id: run.publicId,
    status: "completed",
    purpose: "photo_inventory",
  });
  render(<RunPhotoBatch record={photoRecord} />, {
    wrapper: harness.wrapper,
  });

  expect(await screen.findByText("Proposed items")).toBeInTheDocument();
  expect(screen.getByText("Run progress")).toBeInTheDocument();
  expect(screen.getByText("Timeline and system log")).toBeInTheDocument();
  expect(screen.getByLabelText("Import run transcript")).toHaveTextContent(
    "group-1",
  );
  expect(await screen.findByText("System and Mac log")).toBeInTheDocument();
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
  const defaultFetch = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith(`/api/import/runs/${run.publicId}`))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              run: {
                ...run,
                purpose: "photo_inventory",
                status: "running",
                endedAt: null,
                targets: [],
                operations: [],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      return defaultFetch(input, init);
    }),
  );
  render(
    <RunPhotoBatch
      record={fromPartial<ImportRunOut>({
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
