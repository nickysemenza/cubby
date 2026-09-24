import { describe, expect, it } from "vitest";

import {
  type ActionVerbId,
  actionVerbLabels,
  actionVerbs,
  verbDef,
} from "./action-verbs";

describe("action verb registry", () => {
  it("gives every verb a distinct label", () => {
    expect(new Set(actionVerbLabels).size).toBe(actionVerbLabels.length);
  });

  it("reserves the destructive tone for delete", () => {
    const toned = Object.keys(actionVerbs)
      .filter((id): id is ActionVerbId => id in actionVerbs)
      .filter((id) => verbDef(id).tone === "destructive");
    expect(toned).toEqual(["delete"]);
  });
});
