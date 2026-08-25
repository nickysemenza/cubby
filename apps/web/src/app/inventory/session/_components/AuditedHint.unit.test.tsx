import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuditedHint } from "./AuditedHint";

/**
 * A count is a claim with an expiry, and this component is where that expiry is
 * expressed. The three behaviours pinned here are each a decision that would be
 * silently wrong if reversed:
 *
 *   - a fixture opts out entirely (its count cannot rot, and the warning could
 *     never be cleared because a recount doesn't offer fixtures);
 *   - a stale count stops reporting a relative age, because "audited 412d"
 *     still reads as "roughly current";
 *   - a fresh count keeps the compact relative form.
 */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AuditedHint", () => {
  it("opts a fixture out of staleness entirely", () => {
    // Deliberately ancient: an installed row must not warn no matter how long
    // ago it was touched.
    render(<AuditedHint at={daysAgo(900)} placement="installed" />);

    expect(screen.getByText("installed")).toBeDefined();
    expect(screen.queryByText(/unverified since/)).toBeNull();
    expect(document.querySelector(".text-warning")).toBeNull();
  });

  it("opts out even when the fixture has never been verified", () => {
    render(<AuditedHint at={null} placement="installed" />);

    expect(screen.getByText("installed")).toBeDefined();
    expect(screen.queryByText(/never/)).toBeNull();
  });

  it("names the date once a stock count goes stale, not its age", () => {
    const at = daysAgo(400);
    render(<AuditedHint at={at} />);

    // The point of the change: a relative age implies the number is roughly
    // current, which past the horizon is exactly what we don't know.
    expect(screen.getByText(/^unverified since /)).toBeDefined();
    expect(screen.queryByText(/audited/)).toBeNull();
    expect(document.querySelector(".text-warning-ink")).not.toBeNull();
  });

  it("keeps the compact relative form while a count is fresh", () => {
    render(<AuditedHint at={daysAgo(3)} />);

    expect(screen.getByText(/^audited /)).toBeDefined();
    expect(screen.queryByText(/unverified since/)).toBeNull();
    expect(document.querySelector(".text-warning")).toBeNull();
  });

  it("reports a never-verified stock row plainly", () => {
    render(<AuditedHint at={null} />);

    expect(screen.getByText("never audited")).toBeDefined();
  });

  it("carries the caller's label through both live states", () => {
    const { unmount } = render(
      <AuditedHint at={daysAgo(3)} label="verified" />,
    );
    expect(screen.getByText(/^verified /)).toBeDefined();
    unmount();

    render(<AuditedHint at={null} label="verified" />);
    expect(screen.getByText("never verified")).toBeDefined();
  });
});
