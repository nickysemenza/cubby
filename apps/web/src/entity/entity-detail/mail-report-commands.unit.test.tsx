import {
  reportCommand,
  type ReportCommand,
} from "@cubby/schemas/entity-report";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CommandButton, useReportCommands } from "./report-commands";

const eventId = crypto.randomUUID();
const command = reportCommand.parse({
  id: "synthetic-shipment",
  label: "Research original",
  prominent: false,
  confirm: null,
  request: {
    kind: "research-order-mail",
    eventId,
    evidenceChecksum: "synthetic-original-checksum",
  },
});

function ResearchOriginal({ command }: { command: ReportCommand }) {
  return <CommandButton command={command} commands={useReportCommands()} />;
}

// Preserves the no-order-ID shipment interaction through the shared command renderer.
it("researches a shipment without an order ID and links every server-created Run", async () => {
  const harness = createBrowserTestHarness();
  const calls: unknown[] = [];
  const restore = overrideStartDispatch(async (operation, input) => {
    if (operation !== "vendor.importOrderMail")
      throw new Error(`Unexpected operation: ${operation}`);
    calls.push(input);
    return { ok: true, data: { runIds: ["RUN-4K7M", "RUN-5K8N"] } };
  });
  try {
    const view = render(<ResearchOriginal command={command} />, {
      wrapper: harness.wrapper,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Research original" }),
    );
    for (const ref of ["RUN-4K7M", "RUN-5K8N"])
      expect(await screen.findByRole("link", { name: ref })).toHaveAttribute(
        "href",
        `/runs/${ref}`,
      );
    expect(calls).toEqual([
      {
        eventId,
        evidenceChecksum: "synthetic-original-checksum",
      },
    ]);
    // Refreshed source content keeps the row identity but changes the reviewed operand.
    // Historical Run links belong to the retained report, not this earlier mutation result.
    view.rerender(
      <ResearchOriginal
        command={reportCommand.parse({
          ...command,
          request: {
            ...command.request,
            evidenceChecksum: "synthetic-revised-original-checksum",
          },
        })}
      />,
    );
    for (const ref of ["RUN-4K7M", "RUN-5K8N"])
      expect(screen.queryByRole("link", { name: ref })).toBeNull();
  } finally {
    restore();
    harness.dispose();
  }
});
