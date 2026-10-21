import { parseShortcodeFor, shortcode } from "@cubby/schemas/identifiers";
import type { PhotoGroupProposal } from "@cubby/schemas/photo-import-run";
import { describe, expect, it } from "vitest";

import {
  PhotoReviewDraftSession,
  mergeGroups,
  moveImage,
  reviewOutcomeToasts,
  toGroupInput,
} from "./photo-review-model";

const img = (code: string) => parseShortcodeFor("image", code);

const proposal = (
  groupKey: string,
  images: string[],
  state: PhotoGroupProposal["state"] = "proposed",
): PhotoGroupProposal => ({
  groupKey,
  origin: null,
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
  missingImageCount: 0,
  steps: [],
  blockedReason: null,
  committedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

// Regrouping must preserve item/label purpose: a second angle is not a label,
// and splitting a label must not make it eligible as a Product cover.
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
      groups: { a: ["IMG-AAA2:item", "IMG-AAA3:label", "IMG-BBB2:item"] },
      removed: ["b"],
    },
    {
      name: "splitting picks a groupKey no proposal uses, skipping committed ones",
      edit: () => moveImage(proposals, img("IMG-AAA3"), null),
      groups: { a: ["IMG-AAA2:item"], "a-3": ["IMG-AAA3:label"] },
      removed: [],
    },
    {
      name: "an unassigned photo joins a group without touching others",
      edit: () => moveImage(proposals, img("IMG-NEW2"), "b"),
      groups: { b: ["IMG-BBB2:item", "IMG-NEW2:item"] },
      removed: [],
    },
    {
      name: "combining preserves item purposes and drops the source",
      edit: () => mergeGroups(proposals, "b", "a"),
      groups: { a: ["IMG-AAA2:item", "IMG-AAA3:label", "IMG-BBB2:item"] },
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

  // Regression: a Product or Location deleted after proposing used to be
  // saved back as "create a Product named after the group" / "no inventory",
  // silently rewriting the reviewer's choice on any unrelated edit.
  describe("a deleted reference blocks every save that does not replace it", () => {
    const deletedProduct: PhotoGroupProposal = {
      ...proposal("gone", ["IMG-DDD2", "IMG-DDD3"]),
      product: { kind: "existing", existing: null },
    };
    const deletedLocation: PhotoGroupProposal = {
      ...proposal("lost", ["IMG-EEE2"]),
      inventory: {
        locationId: null,
        locationName: null,
        quantity: 2,
      },
    };
    const stale = [deletedProduct, deletedLocation, proposals[1]!];

    it.each([
      {
        name: "moving a photo out of a group with a deleted product",
        edit: () => moveImage(stale, img("IMG-DDD3"), "b"),
        error: /product was deleted/,
      },
      {
        name: "moving a photo into a group with a deleted location",
        edit: () => moveImage(stale, img("IMG-BBB2"), "lost"),
        error: /location was deleted/,
      },
    ])("refuses $name", ({ edit, error }) => {
      expect(edit).toThrow(error);
    });

    it("accepts a save that picks the replacement", () => {
      const replacement = shortcode("PRD-4K7M");
      expect(
        toGroupInput(deletedProduct, {
          product: { kind: "existing", existingId: replacement },
        }).product,
      ).toEqual({ kind: "existing", existingId: replacement });
      expect(
        toGroupInput(deletedLocation, { inventory: undefined }).inventory,
      ).toBeUndefined();
    });
  });
});

describe("reviewOutcomeToasts", () => {
  // Regression: a save into a group another tab just committed must say the
  // group was left unchanged instead of reporting silent success.
  it("warns about frozen groups on a save that approved nothing", () => {
    expect(
      reviewOutcomeToasts({ results: [], frozenGroupKeys: ["kitchen-mugs"] }),
    ).toEqual([
      {
        tone: "warning",
        title: "Some groups were already settled",
        description: "Left unchanged: kitchen-mugs",
      },
    ]);
  });

  it("separates approved groups from ones needing attention", () => {
    expect(
      reviewOutcomeToasts({
        results: [
          { groupKey: "a", outcome: "committed" },
          { groupKey: "b", outcome: "conflict" },
          { groupKey: "c", outcome: "failed", error: "boom" },
        ],
        frozenGroupKeys: [],
      }),
    ).toEqual([
      {
        tone: "warning",
        title: "1 approved · 2 need attention",
        description: "b: name matches an existing product\nc: boom",
      },
    ]);
  });
});

// A blur save can finish after the reviewer types again; acknowledging its old
// submission must neither erase the newer draft nor another group's draft.
describe("photo review draft session", () => {
  it("acknowledges only submitted text and rebases matching saved values", () => {
    const session = new PhotoReviewDraftSession();
    session.edit("name-a", "a", "First edit", "Saved");
    session.edit("name-b", "b", "Other edit", "Other saved");
    session.edit("name-a", "a", "Later edit", "Saved");
    session.acknowledge("name-a", "First edit");
    expect(session.getSnapshot().drafts.get("name-a")?.value).toBe(
      "Later edit",
    );
    session.acknowledge("name-a", "Later edit");
    expect([...session.getSnapshot().drafts.keys()]).toEqual(["name-b"]);
    session.edit("name-b", "b", "Other saved", "Other saved");
    expect(session.getSnapshot().drafts.size).toBe(0);
  });

  it("waits for blur saves and keeps one approval intent through completion", async () => {
    const session = new PhotoReviewDraftSession();
    let finishSave: () => void = () => {
      throw new Error("save not started");
    };
    const save = session.save(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const applied: string[] = [];
    const approval = session.approve(["a"], async () => {
      await session.flushSaves();
      applied.push("a");
    });
    await session.approve(["b"], async () => {
      applied.push("b");
    });
    expect(session.getSnapshot().approving).toEqual(["a"]);
    expect(applied).toEqual([]);
    finishSave();
    await Promise.all([save, approval]);
    expect(applied).toEqual(["a"]);
    expect(session.getSnapshot().saves.size).toBe(0);
    expect(session.getSnapshot().approving).toBeNull();
  });

  it("retains partial failures and a later selection after submitted successes", () => {
    const session = new PhotoReviewDraftSession();
    session.select(["a", "b", "later"]);
    session.settleSelection(["a", "b"], ["b"]);
    expect([...session.getSnapshot().selected]).toEqual(["later", "b"]);
  });
});
