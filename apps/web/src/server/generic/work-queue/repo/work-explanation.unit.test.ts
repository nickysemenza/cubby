import { workQueueRowSchema } from "@cubby/schemas/work-queue";
import { describe, expect, it } from "vitest";

import { projectWorkExplanations } from "./work-explanation";

// Authority is not a dependency; independent missing fields must not block
// each other's research, and an execution forecast is not a committed effect.
describe("shared action explanations", () => {
  const research = () =>
    workQueueRowSchema.parse({
      entity: "vendor",
      id: "VEN-4K7M",
      name: "Synthetic vendor",
      key: "research:vendor:VEN-4K7M",
      source: "research",
      kind: "research",
      reason: "Missing research",
      reasonKeys: ["vendor_website", "vendor_logo"],
      gaps: [
        { check: "vendor_website", message: "No website is recorded." },
        { check: "vendor_logo", message: "No logo is recorded." },
      ],
      dataQuality: null,
      amount: null,
      date: null,
      vendor: null,
      nextAction: "Research supported facts.",
      waitingFor: { kind: "either" },
      displayImages: [],
    });

  it("keeps website and logo research independently actionable", () => {
    const explanations = projectWorkExplanations(research());
    expect(explanations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.stringContaining("vendor_website"),
          readiness: "ready",
          executor: "agent_session",
          prerequisites: [],
        }),
        expect.objectContaining({
          key: expect.stringContaining("vendor_logo"),
          readiness: "ready",
          executor: "agent_session",
          prerequisites: [],
        }),
      ]),
    );
    expect(
      explanations.every((explanation) => explanation.unblocks.length === 0),
    ).toBe(true);
  });

  it("requires established private source authority before private work", () => {
    const row = research();
    row.waitingFor = {
      kind: "unresolved",
      reason: "Original source owner is unknown.",
    };
    const explanations = projectWorkExplanations(row);
    expect(
      explanations.every((explanation) => explanation.readiness === "blocked"),
    ).toBe(true);
    expect(explanations[0]?.prerequisites).toContainEqual(
      expect.objectContaining({ code: "source_authority", state: "missing" }),
    );
  });

  it("shows posting as a dependency rather than an action ready for a member", () => {
    const row = research();
    row.source = "reconciliation";
    row.kind = "awaiting_posting";
    row.gaps = [];
    const [explanation] = projectWorkExplanations(row);
    expect(explanation).toMatchObject({
      readiness: "blocked",
      executor: "automatic",
      effects: { certainty: "unknown", changes: [] },
    });
    expect(explanation?.prerequisites).toContainEqual(
      expect.objectContaining({ code: "posting", state: "missing" }),
    );
  });

  it("keeps reconciliation investigation actionable without claiming scheduled execution", () => {
    const row = research();
    row.source = "reconciliation";
    row.kind = "repair";
    row.gaps = [];
    expect(projectWorkExplanations(row)[0]).toMatchObject({
      readiness: "ready",
      executor: "human",
    });
  });
});
