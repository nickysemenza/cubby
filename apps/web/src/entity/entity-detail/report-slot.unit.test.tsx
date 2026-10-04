import type {
  EntityReportOut,
  ReportCommand,
} from "@cubby/schemas/entity-report";
import { runShortcode } from "@cubby/schemas/identifiers";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityReportSlot } from "./report-slot";

const RUN_ID = runShortcode.parse("RUN-4K7M");

let harness: ReturnType<typeof createBrowserTestHarness>;
let restoreDispatch: () => void;
let answer: (input: { cursor?: string }) => EntityReportOut;
const calls: Array<{ operation: string; input: unknown }> = [];

beforeEach(() => {
  harness = createBrowserTestHarness();
  calls.length = 0;
  restoreDispatch = overrideStartDispatch(async (operation, input) => {
    calls.push({ operation, input });
    if (operation === "entityReport.get")
      // SAFETY: the test controls the input it sends.
      return { ok: true, data: answer(input as { cursor?: string }) };
    if (operation === "entityReport.getMany")
      return {
        ok: true,
        // SAFETY: the test controls the input it sends.
        data: {
          reports: (input as { slots: string[] }).slots.map((slot) => ({
            slot,
            report: answer({}),
          })),
        },
      };
    if (operation === "run.control")
      return { ok: true, data: { run: {}, successor: null } };
    throw new Error(`Unexpected operation: ${operation}`);
  });
});

afterEach(() => {
  restoreDispatch();
  harness.dispose();
});

const row = (id: string, title: string, commands: ReportCommand[] = []) => ({
  entity: null,
  id: null,
  title,
  subtitle: null,
  trailing: null,
  key: id,
  statuses: [],
  lines: [],
  commands,
});

describe("EntityReportSlot records", () => {
  it("links shortcodes in server text", async () => {
    answer = () => ({
      live: false,
      status: "completed",
      blocks: [
        {
          kind: "records",
          title: "Run progress history",
          empty: "",
          rows: [row("p1", "investigating · IMG-4S9Q")],
        },
      ],
    });
    render(<EntityReportSlot slot="run.import-timeline" id={RUN_ID} />, {
      wrapper: harness.wrapper,
    });
    expect(
      await screen.findByRole("link", { name: "IMG-4S9Q" }),
    ).toHaveAttribute("href", "/images/IMG-4S9Q");
  });

  it("asks before approving and sends the server's exact request only once confirmed", async () => {
    answer = () => ({
      live: true,
      status: "running",
      blocks: [
        {
          kind: "records",
          empty: "",
          rows: [
            row("approval-1", "product_overwrite", [
              {
                id: "approval-1:approve",
                label: "Approve import proposal",
                prominent: true,
                confirm: "Approve product_overwrite?",
                request: {
                  kind: "run-control",
                  runId: RUN_ID,
                  action: "approve",
                  operationId: "op-1",
                  approvalId: "approval-1",
                },
              },
            ]),
          ],
        },
      ],
    });
    render(<EntityReportSlot slot="run.import-approvals" id={RUN_ID} />, {
      wrapper: harness.wrapper,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve import proposal" }),
    );
    // The tap alone must not decide the approval.
    expect(calls.map((call) => call.operation)).not.toContain("run.control");
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Approve product_overwrite?"),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.map((call) => call.operation)).not.toContain("run.control");

    fireEvent.click(
      screen.getByRole("button", { name: "Approve import proposal" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Approve import proposal",
      }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        operation: "run.control",
        input: {
          runId: RUN_ID,
          action: "approve",
          operationId: "op-1",
          approvalId: "approval-1",
        },
      }),
    );
    expect(
      calls.filter((call) => call.operation === "run.control"),
    ).toHaveLength(1);
  });

  it("reads every run slot on the page from one batched request", async () => {
    answer = () => ({
      live: false,
      status: "completed",
      blocks: [{ kind: "records", empty: "", rows: [row("r1", "shared row")] }],
    });
    render(
      <>
        <EntityReportSlot slot="run.import-stats" id={RUN_ID} />
        <EntityReportSlot slot="run.import-purchases" id={RUN_ID} />
        <EntityReportSlot slot="run.import-timeline" id={RUN_ID} />
      </>,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findAllByText("shared row")).toHaveLength(3);
    expect(
      calls.filter((call) => call.operation === "entityReport.getMany"),
    ).toHaveLength(1);
    expect(calls.map((call) => call.operation)).not.toContain(
      "entityReport.get",
    );
  });

  it("refreshes the record once when the batch reports a new status", async () => {
    answer = () => ({
      live: false,
      status: "completed",
      blocks: [{ kind: "note", text: "done" }],
    });
    render(
      <>
        <EntityReportSlot
          slot="run.import-stats"
          id={RUN_ID}
          status="running"
        />
        <EntityReportSlot
          slot="run.import-timeline"
          id={RUN_ID}
          status="running"
        />
      </>,
      { wrapper: harness.wrapper },
    );
    await screen.findAllByText("done");
    // One refresh of the batch for the new status, not one per slot.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.operation === "entityReport.getMany"),
      ).toHaveLength(2),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      calls.filter((call) => call.operation === "entityReport.getMany"),
    ).toHaveLength(2);
  });

  it("keeps untitled record blocks of the first page apart when paging", async () => {
    answer = ({ cursor }) => ({
      live: false,
      status: "completed",
      blocks: cursor
        ? [{ kind: "records", empty: "", rows: [row("c", "third")] }]
        : [
            { kind: "records", empty: "", rows: [row("a", "first")] },
            { kind: "records", empty: "", rows: [row("b", "second")] },
          ],
      nextCursor: cursor ? undefined : "next",
    });
    render(<EntityReportSlot slot="run.ai-usage" id={RUN_ID} />, {
      wrapper: harness.wrapper,
    });
    await screen.findByText("first");
    expect(screen.getByText("second")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("third")).toBeInTheDocument();
    expect(screen.getAllByText("first")).toHaveLength(1);
    expect(screen.getAllByText("second")).toHaveLength(1);
  });

  it("renders nothing for a report with no blocks", async () => {
    answer = () => ({ live: false, status: "completed", blocks: [] });
    const { container } = render(
      <EntityReportSlot slot="run.import-evidence" id={RUN_ID} />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() =>
      expect(container.querySelector(".animate-pulse")).toBeNull(),
    );
    expect(container).toHaveTextContent("");
  });

  it("pages a report with the server's cursor and stacks the rows", async () => {
    answer = ({ cursor }) => ({
      live: false,
      status: "completed",
      blocks: [
        {
          kind: "records",
          empty: "",
          rows: [
            row(cursor ? "call-2" : "call-1", cursor ? "second" : "first"),
          ],
        },
      ],
      nextCursor: cursor ? undefined : "cursor-2",
    });
    render(<EntityReportSlot slot="run.ai-usage" id={RUN_ID} />, {
      wrapper: harness.wrapper,
    });
    expect(await screen.findByText("first")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(calls.at(-1)?.input).toEqual({
      slot: "run.ai-usage",
      id: RUN_ID,
      cursor: "cursor-2",
    });
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
  });
});
