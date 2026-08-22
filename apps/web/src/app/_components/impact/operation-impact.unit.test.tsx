import type {
  ImpactItem,
  PreviewOperation,
  PublicImpactItem,
} from "@cubby/schemas/entity-integrity";
import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperationImpact } from "./operation-impact";

/**
 * These pin the gating decision, which is the subtlest thing in this feature
 * and the easiest to "fix" into being wrong.
 *
 * A preview is ADVISORY. The mutation re-checks everything inside its own
 * transaction, so a preview that is slow, stale, or failed says nothing about
 * whether the mutation would succeed. The component must therefore render a
 * loading or error state WITHOUT ever implying the action is unavailable —
 * only a positively-returned `canProceed: false` means blocked.
 *
 * (The confirm button itself lives in the dialogs, which pass
 * `blocked={preview.data?.canProceed === false}`. That expression is
 * deliberately `=== false` rather than `!preview.data?.canProceed`, so
 * `undefined` — loading or errored — never reads as blocked.)
 */

const preview = (over: Partial<PreviewOperation> = {}): PreviewOperation => ({
  operation: "delete",
  entity: "product",
  mode: "soft",
  targetCount: 1,
  canProceed: true,
  blockers: [],
  changes: [],
  sideEffects: [],
  generatedAt: "2026-07-30T00:00:00.000Z",
  ...over,
});

// Parsed rather than cast: `blockers[]` is the branded wire type, so a fixture
// has to arrive the same way real data does. This also validates the fixture.
const item = (over: Partial<ImpactItem> = {}): PublicImpactItem =>
  publicImpactItemSchema.parse({
    code: "block-live-inventory",
    effect: "block" as const,
    edgeKey: "InventoryEntry.productId",
    label: "inventory entries",
    description: "A product still on a shelf can't be deleted.",
    total: 3,
    byTargetId: { p1: 3 },
    ...over,
  });

describe("OperationImpact", () => {
  it("shows a loading state without claiming anything is blocked", () => {
    render(
      <OperationImpact
        preview={undefined}
        isLoading
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/Checking what this will affect/i)).toBeTruthy();
    expect(screen.queryByText(/Blocked/i)).toBeNull();
  });

  it("offers retry on error, and still does not claim anything is blocked", () => {
    const onRetry = vi.fn();
    render(
      <OperationImpact
        preview={undefined}
        isLoading={false}
        isError
        onRetry={onRetry}
      />,
    );
    // The action is still available — this is lost information, not a lost
    // capability, so the copy must not read as a refusal.
    expect(screen.getByText(/Couldn't load the impact preview/i)).toBeTruthy();
    expect(screen.queryByText(/^Blocked$/)).toBeNull();
    screen.getByRole("button", { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders blockers when the server says the operation cannot proceed", () => {
    render(
      <OperationImpact
        preview={preview({ canProceed: false, blockers: [item()] })}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("inventory entries")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    // Raw disposition slug stays visible as secondary detail.
    expect(screen.getByText("block-live-inventory")).toBeTruthy();
  });

  it("leads with risky changes and discloses the complete consequence ledger", async () => {
    render(
      <OperationImpact
        preview={preview({
          changes: [
            item({
              code: "soft-delete-association",
              effect: "soft-delete",
              label: "images",
              total: 2,
              byTargetId: { "PRD-2222": 2 },
            }),
            item({
              code: "repoint-task",
              effect: "repoint",
              label: "tasks re-pointed",
              total: 1,
              byTargetId: { "PRD-2222": 1 },
            }),
          ],
          sideEffects: [
            item({
              code: "recompute-parents",
              effect: "preserve",
              label: "parent recipes recomputed",
              total: 1,
            }),
          ],
        })}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByText("Blocked")).toBeNull();
    // Risk is visible before opening the ledger; ordinary moves and secondary
    // effects stay out of the confirmation's first scan.
    expect(screen.getByText("images")).toBeTruthy();
    expect(screen.queryByText("tasks re-pointed")).toBeNull();
    expect(screen.queryByText("parent recipes recomputed")).toBeNull();

    screen
      .getByRole("button", { name: /complete consequence ledger \(3\)/i })
      .click();

    expect(await screen.findByText("tasks re-pointed")).toBeTruthy();
    expect(screen.getByText("parent recipes recomputed")).toBeTruthy();
    expect(screen.getByText(/PRD-2222 × 2/)).toBeTruthy();
  });

  it("says so plainly when nothing else references the targets", () => {
    // The common case for leaf entities (expense, inventory) — it must read as
    // reassurance, not as an empty/failed panel.
    render(
      <OperationImpact
        preview={preview()}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/Nothing else references/i)).toBeTruthy();
  });
});
