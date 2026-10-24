import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { render, screen, waitFor, within } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { useState } from "react";
import { expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { RunDecision } from "~/contracts/run-detail.contract";
import { acceptItem } from "~/entity/suggestions/queue/suggestion-review";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { DecisionLedger } from "./decision-ledger";
import type { DecisionPresenter } from "./decision-presenters";

const ready = {
  key: "ready_to_apply",
  label: "Ready",
  tone: "positive",
  description: "Ready to review",
} satisfies DecisionPresenter["facets"][number];
const blocked = {
  key: "needs_review",
  label: "Blocked",
  tone: "warning",
  description: "Blocked evidence",
} satisfies DecisionPresenter["facets"][number];
const applied = {
  key: "applied",
  label: "Applied",
  tone: "positive",
  description: "Applied evidence",
} satisfies DecisionPresenter["facets"][number];
const presenter: DecisionPresenter = {
  noun: "decisions",
  facets: [ready, blocked, applied],
  facetOf: (row) =>
    row.status === "applied"
      ? applied
      : row.judgment === "blocked"
        ? blocked
        : ready,
  explanation: (row) => row.status,
  columns: [
    {
      id: "name",
      header: "Record",
      value: (row) => row.id,
      cell: (row) => row.id,
    },
  ],
  searchText: (row) => row.id,
  title: (row) => row.id,
  Evidence: ({ row }) => <p>Stored {row.status} evidence</p>,
};
const decision = (id: string): RunDecision => ({
  id,
  family: "transfer_pair",
  status: "pending",
  active: true,
  judgment: null,
  producer: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
function Ledger({ rows }: { rows: RunDecision[] }) {
  const [facet, onFacet] = useState<string | null>(null);
  return (
    <DecisionLedger
      rows={rows}
      total={rows.length}
      presenter={presenter}
      facet={facet}
      onFacet={onFacet}
    />
  );
}

it("preserves attention rows and the inspector after resolution while arrivals wait", async () => {
  await page.viewport(1440, 1200);
  const harness = createBrowserTestHarness();
  try {
    const first = decision("00000000-0000-4000-8000-000000000001");
    const blockedRow = {
      ...decision("00000000-0000-4000-8000-000000000002"),
      judgment: "blocked",
    };
    const view = render(<Ledger rows={[first, blockedRow]} />, {
      wrapper: harness.wrapper,
    });
    expect(
      screen.queryByRole("row", { name: new RegExp(blockedRow.id) }),
    ).toBeNull();
    await userEvent.click(
      await screen.findByRole("row", { name: new RegExp(first.id) }),
    );
    const arrival = decision("00000000-0000-4000-8000-000000000003");
    view.rerender(
      <Ledger rows={[arrival, { ...first, status: "applied" }, blockedRow]} />,
    );
    expect(
      await within(
        screen.getByRole("complementary", { name: "Decision evidence" }),
      ).findByText("Stored applied evidence"),
    ).toBeVisible();
    expect(
      screen.getByRole("row", { name: new RegExp(first.id) }),
    ).toBeVisible();
    expect(
      screen.queryByRole("row", { name: new RegExp(arrival.id) }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 new items" }),
    );
    expect(
      await screen.findByRole("row", { name: new RegExp(arrival.id) }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Results" }));
    expect(
      await screen.findByRole("row", { name: new RegExp(blockedRow.id) }),
    ).toBeVisible();
  } finally {
    harness.dispose();
  }
});

it("selected clean decisions override filtered-ready scope and retain review fingerprints", async () => {
  await page.viewport(1440, 1200);
  const harness = createBrowserTestHarness();
  try {
    const rows = [
      decision("00000000-0000-4000-8000-000000000011"),
      decision("00000000-0000-4000-8000-000000000012"),
      decision("00000000-0000-4000-8000-000000000013"),
    ];
    const queue = rows.map((row, index) =>
      fromPartial<SuggestionListRow>({
        id: row.id,
        assessmentId: row.id,
        family: "image_description",
        clean: index < 2,
        fingerprint: `synthetic-fingerprint-${index}`,
        actions: [{ verb: "accept", ownerOnly: false }],
        impact: [{ kind: "resolves", label: `Impact ${index}` }],
        evidence: { description: `Change ${index}` },
      }),
    );
    const requests: ReturnType<typeof acceptItem>[] = [];
    render(
      <DecisionLedger
        rows={rows}
        total={3}
        presenter={presenter}
        facet={null}
        onFacet={() => {}}
        actionableRows={queue}
        reviewReady={async (scope) => {
          requests.push(...scope.map((row) => acceptItem(row)));
          return 0;
        }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByRole("button", { name: "Accept 2 ready in view" }),
    ).toBeEnabled();
    const row = screen.getByRole("row", {
      name: new RegExp(rows[0]?.id ?? "missing"),
    });
    await userEvent.click(
      within(row).getByRole("checkbox", { name: "Select row" }),
    );
    expect(await screen.findByText(/On accept: Impact 0/)).toBeVisible();
    await userEvent.type(
      screen.getByPlaceholderText("Search account, amount, ID"),
      rows[1]?.id ?? "missing",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("row", {
          name: new RegExp(rows[0]?.id ?? "missing"),
        }),
      ).toBeNull(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Accept 1 ready selected" }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.assessmentId).toBe(rows[0]?.id);
    expect(requests[0]?.expectedFingerprint).toBe("synthetic-fingerprint-0");
  } finally {
    harness.dispose();
  }
});
