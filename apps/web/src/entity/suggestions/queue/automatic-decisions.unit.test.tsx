import { automaticDecisionRow } from "@cubby/schemas/automatic-decision";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { RecordList } from "~/ui/common/record-list";

import { AutomaticDecision } from "./automatic-decisions";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

describe("correction attempt history", () => {
  it("discloses a held attempt without implying an application or requesting feedback", () => {
    const sourceFeedbackId = crypto.randomUUID();
    const sourceApplicationFeedbackId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const row = automaticDecisionRow.parse({
      id: crypto.randomUUID(),
      family: "field",
      records: [],
      decision: {},
      summary:
        "Automatic correction held: Complete decision inputs are not equivalent",
      applicationVerified: false,
      createdAt: "2026-10-24T00:00:00.000Z",
      fingerprint: null,
      automaticRule: null,
      verdict: "wrong",
      reviewedAt: null,
      correction: null,
      correctionAttempt: {
        receiptId,
        sourceFeedbackId,
        sourceApplicationFeedbackId,
        createdAt: "2026-10-24T01:00:00.000Z",
        outcome: {
          status: "held",
          reason: "Complete decision inputs are not equivalent",
        },
      },
    });
    render(
      <RecordList>
        <AutomaticDecision row={row} />
      </RecordList>,
      { wrapper: harness.wrapper },
    );
    expect(
      screen.getByRole("region", { name: "Recorded correction attempt" }),
    ).toBeVisible();
    expect(screen.queryByText("Applied result")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Report incorrect" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Unverified application/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Applied records stay as they are/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Correction provenance"));
    expect(screen.getByText(sourceApplicationFeedbackId)).toBeVisible();
    expect(screen.getByText(sourceFeedbackId)).toBeVisible();
    expect(screen.getByText(receiptId)).toBeVisible();
    expect(screen.getByText(/not a current eligibility check/)).toBeVisible();
  });
});
