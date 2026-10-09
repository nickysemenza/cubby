import { describe, expect, it, vi } from "vitest";

import { resumeResearchSignal, renderSignal } from "./signals";

describe("host retained research observation", () => {
  it("consumes broker bookkeeping before presenting a retained observation to the model", async () => {
    const incoming = {
      type: "purchase-import.browser_result",
      attributes: { eventId: "delivery-1" },
      body: '{"commandId":"host-only-command"}',
    };
    const resume = vi.fn().mockResolvedValue({
      workRef: "retained-work",
      observation: "Observed selected item.",
    });
    const resolved = await resumeResearchSignal(incoming, resume);
    expect(resume).toHaveBeenCalledWith(incoming);
    expect(resolved?.type).toBe("research_observation");
    expect(renderSignal(resolved!)).toContain("Observed selected item.");
    expect(renderSignal(resolved!)).not.toContain("host-only-command");
  });
  it("does not submit a broker bookkeeping signal without an observation", async () => {
    expect(
      await resumeResearchSignal(
        { type: "purchase-import.browser_result", body: "host command" },
        async () => null,
      ),
    ).toBeNull();
    const start = {
      type: "purchase-import.start",
      body: "Begin assigned research.",
    };
    expect(await resumeResearchSignal(start, async () => null)).toEqual(start);
  });
});
