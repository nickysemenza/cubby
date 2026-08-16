import { describe, expect, it } from "vitest";
import {
  type ActionVerbId,
  actionVerbLabels,
  actionVerbs,
  verbDef,
} from "./action-verbs";

const entries = Object.entries(actionVerbs);

describe("action verb registry", () => {
  // The whole point: one operation, one wording. Two verbs sharing a label
  // means a call site has to guess which id it wants.
  it("gives every verb a distinct label", () => {
    expect(new Set(actionVerbLabels).size).toBe(actionVerbLabels.length);
  });

  it("uses sentence case, never Title Case", () => {
    for (const [id, { label }] of entries) {
      // Every word after the first must start lowercase, unless it is a proper
      // noun — of which this registry currently has none.
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

  // ASCII, matching every label that already shipped. A stray `…` would read
  // identically to a reviewer and defeat the point of a single spelling.
  it("uses ASCII dots for the needs-more-input suffix", () => {
    for (const [id, { label }] of entries) {
      expect(label.includes("…"), `${id} → "${label}"`).toBe(false);
      if (label.endsWith(".")) {
        expect(label.endsWith("..."), `${id} → "${label}"`).toBe(true);
      }
    }
  });

  it("never trails a single or double dot", () => {
    for (const [id, { label }] of entries) {
      expect(/(^|[^.])\.\.?$/.test(label), `${id} → "${label}"`).toBe(false);
    }
  });

  // Destructive styling is a strong signal; spending it on anything short of
  // an actual delete makes it stop meaning anything. `removeFromProject`
  // unlinks rather than removes, and stays untoned — as it rendered before.
  it("reserves the destructive tone for delete alone", () => {
    const toned = Object.keys(actionVerbs).filter(
      (id) => verbDef(id as ActionVerbId).tone === "destructive",
    );
    expect(toned).toEqual(["delete"]);
  });

  it("exposes tone through verbDef despite the const narrowing", () => {
    expect(verbDef("delete").tone).toBe("destructive");
    expect(verbDef("recount").tone).toBeUndefined();
  });
});
