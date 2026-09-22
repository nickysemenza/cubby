import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PhotoGroupProposal } from "@cubby/schemas/photo-import-run";
import { describe, expect, it } from "vitest";

import { mergeGroups, moveImage } from "./photo-review-model";

const img = (code: string) => parseShortcodeFor("image", code);

const proposal = (
  groupKey: string,
  images: string[],
  state: PhotoGroupProposal["state"] = "proposed",
): PhotoGroupProposal => ({
  groupKey,
  state,
  images: images.map((code, index) => ({
    id: img(code),
    purpose: index === 0 ? "item" : "label",
  })),
  skip: [],
  product: { kind: "create", create: { name: `Item ${groupKey}` } },
  committedProduct: null,
  inventory: null,
  evidence: null,
  conflict: null,
  lastError: null,
  committedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("photo review edits", () => {
  const proposals = [
    proposal("a", ["IMG-AAA2", "IMG-AAA3"]),
    proposal("b", ["IMG-BBB2"]),
    proposal("a-2", ["IMG-CCC2"], "committed"),
  ];

  it.each([
    {
      name: "moving the last photo out removes the emptied group",
      edit: () => moveImage(proposals, img("IMG-BBB2"), "a"),
      groups: { a: ["IMG-AAA2:item", "IMG-AAA3:label", "IMG-BBB2:label"] },
      removed: ["b"],
    },
    {
      name: "splitting picks a groupKey no proposal uses, skipping committed ones",
      edit: () => moveImage(proposals, img("IMG-AAA3"), null),
      groups: { a: ["IMG-AAA2:item"], "a-3": ["IMG-AAA3:item"] },
      removed: [],
    },
    {
      name: "an unassigned photo joins a group without touching others",
      edit: () => moveImage(proposals, img("IMG-NEW2"), "b"),
      groups: { b: ["IMG-BBB2:item", "IMG-NEW2:label"] },
      removed: [],
    },
    {
      name: "merging folds photos in as label shots and drops the source",
      edit: () => mergeGroups(proposals, "b", "a"),
      groups: { a: ["IMG-AAA2:item", "IMG-AAA3:label", "IMG-BBB2:label"] },
      removed: ["b"],
    },
  ])("$name", ({ edit, groups, removed }) => {
    const result = edit();
    expect(
      Object.fromEntries(
        result.groups.map((group) => [
          group.groupKey,
          group.images.map((image) => `${image.id}:${image.purpose}`),
        ]),
      ),
    ).toEqual(groups);
    expect(result.removeGroupKeys).toEqual(removed);
  });
});
