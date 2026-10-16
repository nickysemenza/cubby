import {
  reportCommand,
  type ReportCommand,
} from "@cubby/schemas/entity-report";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { entityPreviewQueryOptions } from "~/entity/entity-query";
import { overrideStartDispatch } from "~/integrations/tanstack-query/start-transport";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CommandButton, useReportCommands } from "./report-commands";

const original = "a".repeat(64);
const revised = "b".repeat(64);
const command = reportCommand.parse({
  id: "synthetic-shipment",
  label: "Import this Email",
  prominent: false,
  confirm: null,
  request: {
    kind: "import-email",
    items: [{ id: "EML-4K7M", expectedChecksum: original }],
  },
});

function ImportEmail({ command }: { command: ReportCommand }) {
  return <CommandButton command={command} commands={useReportCommands()} />;
}

// Preserves the no-order-ID shipment interaction through the shared command renderer.
it("imports a shipment without an order ID and links every server-created Run", async () => {
  const harness = createBrowserTestHarness();
  const calls: unknown[] = [];
  for (const [index, ref] of ["RUN-4K7M", "RUN-5K8N"].entries())
    harness.queryClient.setQueryData(
      entityPreviewQueryOptions("run", ref).queryKey,
      { id: ref, displayName: `Synthetic import ${index + 1}` },
    );
  const restore = overrideStartDispatch(async (operation, input) => {
    if (operation !== "purchaseImport.emailImport")
      throw new Error(`Unexpected operation: ${operation}`);
    calls.push(input);
    return { ok: true, data: { runIds: ["RUN-4K7M", "RUN-5K8N"] } };
  });
  try {
    const view = render(<ImportEmail command={command} />, {
      wrapper: harness.wrapper,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Import this Email" }),
    );
    for (const [index, ref] of ["RUN-4K7M", "RUN-5K8N"].entries())
      expect(
        await screen.findByRole("link", {
          name: `Synthetic import ${index + 1}`,
        }),
      ).toHaveAttribute("href", `/runs/${ref}`);
    expect(calls).toEqual([
      { items: [{ id: "EML-4K7M", expectedChecksum: original }] },
    ]);
    // Refreshed source content keeps the row identity but changes the reviewed operand.
    // Historical Run links belong to the retained report, not this earlier mutation result.
    view.rerender(
      <ImportEmail
        command={reportCommand.parse({
          ...command,
          request: {
            kind: "import-email",
            items: [{ id: "EML-4K7M", expectedChecksum: revised }],
          },
        })}
      />,
    );
    for (const [index] of ["RUN-4K7M", "RUN-5K8N"].entries())
      expect(
        screen.queryByRole("link", { name: `Synthetic import ${index + 1}` }),
      ).toBeNull();
  } finally {
    restore();
    harness.dispose();
  }
});
