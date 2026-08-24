import { describe, expect, it } from "vitest";
import {
  type ActionVerbId,
  actionVerbLabels,
  actionVerbs,
  verbDef,
} from "./action-verbs";

const entries = Object.entries(actionVerbs);

describe("action verb registry", () => {
  it("gives every verb a distinct label", () => {
    expect(new Set(actionVerbLabels).size).toBe(actionVerbLabels.length);
  });

  it("uses sentence case", () => {
    for (const [id, { label }] of entries) {
      const offenders = label
        .split(" ")
        .slice(1)
        .filter((word) => /^[A-Z]/.test(word));
      expect(offenders, `${id} → "${label}"`).toEqual([]);
    }
  });

  it("starts every label with a capital", () => {
    for (const [id, { label }] of entries) {
      expect(/^[A-Z]/.test(label), `${id} → "${label}"`).toBe(true);
    }
  });

  it("uses three ASCII dots for needs-more-input suffixes", () => {
    for (const [id, { label }] of entries) {
      expect(label.includes("…"), `${id} → "${label}"`).toBe(false);
      expect(/(^|[^.])\.\.?$/.test(label), `${id} → "${label}"`).toBe(false);
    }
  });

  it("reserves the destructive tone for delete", () => {
    const toned = Object.keys(actionVerbs).filter(
      (id) => verbDef(id as ActionVerbId).tone === "destructive",
    );
    expect(toned).toEqual(["delete"]);
  });

  it("exposes tone through verbDef despite const narrowing", () => {
    expect(verbDef("delete").tone).toBe("destructive");
    expect(verbDef("recount").tone).toBeUndefined();
  });
});
