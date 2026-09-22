import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  ArrayPruneSuggestSpec,
  FieldSuggestSpec,
  RawBasis,
  ReferenceSuggestSpec,
} from "~/server/ai/field-suggest/registry";
import { FIELD_SUGGEST_REGISTRY } from "~/server/ai/field-suggest/registry";
import type { JevPort } from "~/server/ai/jev";
import type { Database } from "~/server/db";

import { suggestFields } from "./suggest-fields";

// SAFETY: every case below resolves through a real registry entry (pure
// vocabulary/rules, no DB) or a `ports.registry` fake, and label resolution
// goes through `ports.resolveLabels` — nothing in this file ever touches `db`.
const fakeDb = {} as Database;

type JevInput = Parameters<JevPort>[0];

/**
 * A fake `JevPort` that picks whichever criterion's rendered label contains
 * the first matching needle, and fills every other criterion's probability
 * so `validateProbabilities` (`jev.ts`) accepts the response. Generic over
 * both enum and reference/text choices — every spec renders its own criteria
 * labels, so the port only needs to recognize distinctive substrings.
 */
function jevPortPicking(...needles: string[]) {
  return vi.fn(async (input: JevInput) => {
    const entries = Object.entries(input.questions.selection.criteria);
    const needle = needles.find((n) =>
      entries.some(([, label]) => label.includes(n)),
    );
    const match = needle
      ? entries.find(([, label]) => label.includes(needle))
      : undefined;
    const [choiceKey] = match ?? entries[0]!;
    const rest = entries.filter(([key]) => key !== choiceKey);
    const winnerProbability = 0.9;
    const each = rest.length > 0 ? (1 - winnerProbability) / rest.length : 0;
    const probabilities = Object.fromEntries([
      [choiceKey, winnerProbability],
      ...rest.map(([key]) => [key, each] as const),
    ]);
    return {
      answers: {
        selection: {
          type: "choice" as const,
          choice: choiceKey,
          confidence: winnerProbability,
          probabilities,
        },
      },
    };
  });
}

/** A fake `JevPort` pinned to one choice index and probability — for prune
 * cases where the test cares about the exact threshold boundary, unlike
 * `jevPortPicking`'s fixed 0.9 winner. */
function jevPortAt(choiceIndex: number, probability: number): JevPort {
  return vi.fn(async (input: JevInput) => {
    const entries = Object.entries(input.questions.selection.criteria);
    const [choiceKey] = entries[choiceIndex]!;
    const rest = entries.filter(([key]) => key !== choiceKey);
    const each = rest.length > 0 ? (1 - probability) / rest.length : 0;
    const probabilities = Object.fromEntries([
      [choiceKey, probability],
      ...rest.map(([key]) => [key, each] as const),
    ]);
    return {
      answers: {
        selection: {
          type: "choice" as const,
          choice: choiceKey,
          confidence: probability,
          probabilities,
        },
      },
    };
  });
}

/** A fake `JevPort` that always answers `none`, at the given per-key
 * probabilities — for asserting an `evaluated/none` outcome's probability
 * and ranked alternatives independent of `jevPortPicking`'s fixed winner. */
function jevPortNone(probabilities: Record<string, number>): JevPort {
  return vi.fn(async () => ({
    answers: {
      selection: {
        type: "choice" as const,
        choice: "none",
        confidence: probabilities.none ?? 0,
        probabilities,
      },
    },
  }));
}

/** A fake `JevPort` for `resolvePruneTarget`'s per-tag calls: answers each
 * survivor's binary "redundant"/"genuine" choice by matching the tag's
 * value against `input.state` (the rendered subject), so a multi-survivor
 * test can pin a different answer per tag. */
function jevPortForTags(
  responses: Record<string, { choiceIndex: number; probability: number }>,
): JevPort {
  return vi.fn(async (input: JevInput) => {
    const tag = Object.keys(responses).find((t) => input.state.includes(t));
    if (!tag) throw new Error(`No fake response for state: ${input.state}`);
    const { choiceIndex, probability } = responses[tag]!;
    const entries = Object.entries(input.questions.selection.criteria);
    const [choiceKey] = entries[choiceIndex]!;
    const rest = entries.filter(([key]) => key !== choiceKey);
    const each = rest.length > 0 ? (1 - probability) / rest.length : 0;
    const probabilities = Object.fromEntries([
      [choiceKey, probability],
      ...rest.map(([key]) => [key, each] as const),
    ]);
    return {
      answers: {
        selection: {
          type: "choice" as const,
          choice: choiceKey,
          confidence: probability,
          probabilities,
        },
      },
    };
  });
}

const tagsArraySchema = z.array(z.string());

function rawTagsArray(raw: RawBasis): readonly string[] {
  const value = raw.tags;
  if (!value) return [];
  // SAFETY: parsed and shape-checked by `tagsArraySchema` immediately below —
  // an invalid/absent basis value reads as "no tags", not a thrown error.
  const parsed: unknown = JSON.parse(value);
  const result = tagsArraySchema.safeParse(parsed);
  return result.success ? result.data : [];
}

/** Test double for `product.tags`'s `ArrayPruneSuggestSpec`: `deterministic`
 * is caller-supplied (defaults to "nothing is redundant"), so each test only
 * varies what it needs. Never touches `db` — the real entry's `categoryId`
 * lookup only fires when the test basis supplies one. */
function fakeTagPruneSpec(
  deterministic: ArrayPruneSuggestSpec["deterministic"] = async () => [],
): ArrayPruneSuggestSpec {
  return {
    kind: "prune",
    rules:
      "Decide whether the candidate tag restates the subject or is a genuine compatibility token.",
    arrayKey: "tags",
    maxJevCandidates: 8,
    candidates: (_basis, raw) => rawTagsArray(raw),
    deterministic,
    subject: (_basis, value) => `Candidate tag: "${value}"`,
  } satisfies ArrayPruneSuggestSpec;
}

interface FakeProject {
  id: string;
  name: string;
}

const FAKE_PROJECTS: FakeProject[] = [
  { id: "PRJ-AAAA", name: "Kitchen Remodel" },
  { id: "PRJ-BBBB", name: "Deck Build" },
];

/** Roster-backed test double for a reference target, so `it.each` below
 * never has to stand up a database — the seam `ports.registry` exists for. */
function fakeProjectSpec(
  roster: readonly FakeProject[] = FAKE_PROJECTS,
): FieldSuggestSpec {
  return {
    kind: "reference",
    entity: "project",
    rules: "Pick the one matching project, or none if it isn't tied to one.",
    maxCandidates: 10,
    roster: async () => roster,
    idOf: (c) => c.id,
    labelOf: (c) => c.name,
    detailOf: () => null,
    renderLine: (c) => `${c.id} | ${c.name}`,
    subject: (basis) =>
      Object.entries(basis)
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([key, value]) => `${key}: "${value}"`)
        .join("\n"),
  } satisfies ReferenceSuggestSpec<FakeProject>;
}

interface TableCase {
  name: string;
  entity: FieldSuggestionsInput["entity"];
  targets: string[];
  basis: Record<string, string | null>;
  jev: JevPort;
  registry?: Partial<Record<string, FieldSuggestSpec>>;
  assert: (out: FieldSuggestionsOut, jev: JevPort) => void;
}

describe("suggestFields", () => {
  const cases: TableCase[] = [
    {
      name: "an enum target classifies and resolves its label from the manifest's label map",
      entity: "expense",
      targets: ["trade"],
      basis: { name: "panel upgrade" },
      jev: jevPortPicking("electrical:"),
      assert: (out) => {
        expect(out.suggestions.trade).toEqual({
          value: "electrical",
          label: TRADE_LABELS.electrical,
          detail: null,
          confidence: "high",
          probability: 0.9,
          reasoning: "",
          // Every non-winning trade ties on probability under this fake
          // port, so only the shape (top 3, winner excluded) is stable —
          // not which three of 18 equal-probability ties land first.
          alternatives: expect.any(Array),
          operation: "set",
          removals: [],
        });
        expect(out.suggestions.trade?.alternatives).toHaveLength(3);
        expect(
          out.suggestions.trade?.alternatives.map((a) => a.value),
        ).not.toContain("electrical");
        // (d) an evaluated/pick outcome's probability matches the suggestion's.
        expect(out.outcomes?.trade).toEqual({
          kind: "evaluated",
          answer: "pick",
          confidence: "high",
          probability: out.suggestions.trade?.probability,
          alternatives: out.suggestions.trade?.alternatives,
        });
      },
    },
    {
      name: "a reference target picks from its roster and carries the candidate's label/detail",
      entity: "task",
      targets: ["projectId"],
      basis: { name: "build a shelf for the kitchen" },
      jev: jevPortPicking("Kitchen Remodel"),
      registry: { "task.projectId": fakeProjectSpec() },
      assert: (out) => {
        expect(out.suggestions.projectId).toEqual({
          value: "PRJ-AAAA",
          label: "Kitchen Remodel",
          detail: null,
          confidence: "high",
          probability: 0.9,
          reasoning: "",
          alternatives: [
            {
              value: "PRJ-BBBB",
              label: "Deck Build",
              detail: null,
              probability: (1 - 0.9) / 2,
            },
          ],
          operation: "set",
          removals: [],
        });
      },
    },
    {
      name: "an all-null basis resolves to null without calling the model",
      entity: "product",
      targets: ["categoryId"],
      basis: {},
      jev: jevPortPicking("food:"),
      assert: (out, jev) => {
        expect(out.suggestions.categoryId).toBeNull();
        // (a) a basis without signal is never asked.
        expect(out.outcomes?.categoryId).toEqual({
          kind: "skipped",
          reason: "no_signal",
        });
        expect(jev).not.toHaveBeenCalled();
      },
    },
    {
      // (b) an empty roster is never asked either — it never reaches Jev.
      name: "a reference target whose roster is empty skips without calling Jev",
      entity: "task",
      targets: ["projectId"],
      basis: { name: "general upkeep" },
      jev: jevPortPicking("Kitchen Remodel"),
      registry: { "task.projectId": fakeProjectSpec([]) },
      assert: (out, jev) => {
        expect(out.suggestions.projectId).toBeNull();
        expect(out.outcomes?.projectId).toEqual({
          kind: "skipped",
          reason: "no_candidates",
        });
        expect(jev).not.toHaveBeenCalled();
      },
    },
    {
      // (c) a decline still carries Jev's probability and ranked runners-up.
      name: "a reference target's Jev decline surfaces as evaluated/none with the ranked runners-up",
      entity: "task",
      targets: ["projectId"],
      basis: { name: "general upkeep" },
      jev: jevPortNone({ c0: 0.25, c1: 0.15, none: 0.6 }),
      registry: { "task.projectId": fakeProjectSpec() },
      assert: (out) => {
        expect(out.suggestions.projectId).toBeNull();
        expect(out.outcomes?.projectId).toEqual({
          kind: "evaluated",
          answer: "none",
          confidence: "medium",
          probability: 0.6,
          alternatives: [
            {
              value: "PRJ-AAAA",
              label: "Kitchen Remodel",
              detail: null,
              probability: 0.25,
            },
            {
              value: "PRJ-BBBB",
              label: "Deck Build",
              detail: null,
              probability: 0.15,
            },
          ],
        });
      },
    },
    {
      name: "a prune target's deterministic hits are included at probability 1 with no Jev call",
      entity: "product",
      targets: ["tags"],
      basis: {
        manufacturer: "Acme",
        tags: JSON.stringify(["acme"]),
      },
      jev: jevPortPicking("restates"),
      registry: {
        "product.tags": fakeTagPruneSpec(async (_basis, raw) =>
          rawTagsArray(raw)
            .filter((value) => value === "acme")
            .map((value) => ({
              value,
              reason: "manufacturer",
              matched: "Acme",
            })),
        ),
      },
      assert: (out, jev) => {
        expect(out.suggestions.tags).toEqual({
          value: "acme",
          label: "Remove acme",
          detail: "restates manufacturer",
          confidence: "high",
          probability: 1,
          reasoning: "",
          alternatives: [],
          operation: "remove",
          removals: [
            { value: "acme", probability: 1, reason: "restates manufacturer" },
          ],
        });
        // (f) deterministic-only removals stay a pick, probability 1.
        expect(out.outcomes?.tags).toEqual({
          kind: "evaluated",
          answer: "pick",
          confidence: "high",
          probability: 1,
          alternatives: [],
        });
        expect(jev).not.toHaveBeenCalled();
      },
    },
    {
      name: "a prune target's Jev survivor below the 0.85 include floor is excluded",
      entity: "product",
      targets: ["tags"],
      basis: { manufacturer: "Acme", tags: JSON.stringify(["battery"]) },
      jev: jevPortAt(0, 0.6),
      registry: { "product.tags": fakeTagPruneSpec() },
      assert: (out, jev) => {
        expect(out.suggestions.tags).toBeNull();
        expect(jev).toHaveBeenCalledTimes(1);
      },
    },
    {
      // (e) every survivor judged genuine: the min P(genuine) and the
      // survivors ranked by P(redundant), read off Jev's distribution rather
      // than derived as `1 - p`.
      name: "a prune target where every survivor is judged genuine reports evaluated/none with the min P(genuine) and ranked P(redundant)",
      entity: "product",
      targets: ["tags"],
      basis: {
        manufacturer: "Acme",
        tags: JSON.stringify(["battery", "waterproof"]),
      },
      jev: jevPortForTags({
        battery: { choiceIndex: 1, probability: 0.75 },
        waterproof: { choiceIndex: 1, probability: 0.5 },
      }),
      registry: { "product.tags": fakeTagPruneSpec() },
      assert: (out) => {
        expect(out.suggestions.tags).toBeNull();
        expect(out.outcomes?.tags).toEqual({
          kind: "evaluated",
          answer: "none",
          confidence: "low",
          probability: 0.5,
          alternatives: [
            {
              value: "waterproof",
              label: "waterproof",
              detail: null,
              probability: 0.5,
            },
            {
              value: "battery",
              label: "battery",
              detail: null,
              probability: 0.25,
            },
          ],
        });
      },
    },
    {
      name: "a prune target with no current entries resolves to null",
      entity: "product",
      targets: ["tags"],
      basis: { manufacturer: "Acme", tags: JSON.stringify([]) },
      jev: jevPortPicking("restates"),
      registry: { "product.tags": fakeTagPruneSpec() },
      assert: (out, jev) => {
        expect(out.suggestions.tags).toBeNull();
        expect(out.outcomes?.tags).toEqual({
          kind: "skipped",
          reason: "no_candidates",
        });
        expect(jev).not.toHaveBeenCalled();
      },
    },
  ];

  it.each(cases)(
    "$name",
    async ({ entity, targets, basis, jev, registry, assert }) => {
      const out = await suggestFields(
        fakeDb,
        { entity, targets, basis, basisMode: "suggested" },
        { jev, registry },
      );
      assert(out, jev);
    },
  );

  it("renders every category's full hierarchy and lexical evidence", () => {
    const spec = FIELD_SUGGEST_REGISTRY["product.categoryId"];
    expect(spec.kind).toBe("reference");
    if (spec.kind !== "reference") return;

    const rootId = testShortcode("productCategory", "CAT-1ABC");
    const groupId = testShortcode("productCategory", "CAT-2ABC");
    const leafId = testShortcode("productCategory", "CAT-3ABC");
    expect(
      spec.renderLine({
        id: leafId,
        name: "Rain shell",
        path: [
          { id: rootId, name: "Apparel" },
          { id: groupId, name: "Outerwear" },
          { id: leafId, name: "Rain shell" },
        ],
        aliases: ["waterproof jacket"],
        description: "Outer layer for wet weather.",
        ancestorIds: [rootId, groupId],
        feature: "apparel",
      }),
    ).toBe(
      "CAT-3ABC | Apparel > Outerwear > Rain shell — aliases: waterproof jacket — description: Outer layer for wet weather.",
    );
    expect(spec.maxCandidates).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["provided", "suggested"] as const)(
    "runs independent fields concurrently in %s mode",
    async (basisMode) => {
      const release: Array<() => void> = [];
      const pick = jevPortPicking();
      const jev: JevPort = async (input) => {
        await new Promise<void>((resolve) => {
          release.push(resolve);
        });
        return pick(input);
      };
      const result = suggestFields(
        fakeDb,
        {
          entity: "meal",
          targets: ["mealType", "mealKind"],
          basis: { name: "evening meal" },
          basisMode,
        },
        { jev },
      );
      await vi.waitFor(() => expect(release).toHaveLength(2));
      release.forEach((resolve) => resolve());
      expect(Object.keys((await result).suggestions)).toHaveLength(2);
    },
  );

  it("does not turn an unaccepted project proposal into trade evidence", async () => {
    const jev = jevPortPicking("Kitchen Remodel", "electrical:");
    const labels = vi.fn(async () => new Map<string, string>());
    await suggestFields(
      fakeDb,
      {
        entity: "expense",
        targets: ["projectId", "trade"],
        basis: { name: "panel upgrade", projectId: null },
        basisMode: "provided",
      },
      {
        jev,
        resolveLabels: labels,
        registry: { "expense.projectId": fakeProjectSpec() },
      },
    );
    const trade = jev.mock.calls.find(([input]) =>
      Object.values(input.questions.selection.criteria).some((label) =>
        label.startsWith("electrical:"),
      ),
    );
    expect(trade?.[0].state).not.toContain("Kitchen Remodel");
    expect(labels.mock.calls.flat()).not.toContain("PRJ-AAAA");
  });

  it("rejects an unknown target without calling the model", async () => {
    const jev = jevPortPicking();

    await expect(
      suggestFields(
        fakeDb,
        {
          basisMode: "provided",
          entity: "task",
          targets: ["notAField"],
          basis: {},
        },
        { jev },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      reason: "SUGGEST_FIELD_UNKNOWN",
    });
    expect(jev).not.toHaveBeenCalled();
  });

  it.each(["tax", "auto", null])(
    "forbids project suggestions for adjustment drafts with line kind %s",
    async (lineKind) => {
      const jev = jevPortPicking("Kitchen Remodel");
      await expect(
        suggestFields(
          fakeDb,
          {
            basisMode: "provided",
            entity: "expense",
            targets: ["projectId"],
            basis: { name: "Sales tax", lineKind },
          },
          { jev, registry: { "expense.projectId": fakeProjectSpec() } },
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        reason: "SUGGEST_FIELD_FORBIDDEN",
      });
      expect(jev).not.toHaveBeenCalled();
    },
  );

  it("resolves automatic principal line kinds before asking for projects", async () => {
    const result = await suggestFields(
      fakeDb,
      {
        basisMode: "suggested",
        entity: "expense",
        targets: ["projectId"],
        basis: { name: "Kitchen shelf", lineKind: "auto" },
      },
      {
        jev: jevPortPicking("Kitchen Remodel"),
        registry: { "expense.projectId": fakeProjectSpec() },
      },
    );
    expect(result.suggestions.projectId?.value).toBe("PRJ-AAAA");
  });

  it("excludes an inherited target using the authoritative draft snapshot", async () => {
    const jev = jevPortPicking("electrical:");
    const fieldResolutions = {
      trade: {
        mode: "inherit" as const,
        storedValue: null,
        value: "plumbing",
        fallbackValue: "plumbing",
        source: "Project default",
        sourceEntity: { entityType: "project" as const, entityId: "PRJ-AAAA" },
        matchesFallback: true,
        canReset: false,
      },
    };
    const result = await suggestFields(
      fakeDb,
      {
        basisMode: "suggested",
        entity: "expense",
        targets: ["trade"],
        basis: { name: "replace a valve", trade: null },
      },
      {
        jev,
        resolveInheritance: async () => fieldResolutions,
      },
    );

    expect(result).toEqual({
      suggestions: {},
      outcomes: { trade: { kind: "skipped", reason: "resolved" } },
      fieldResolutions,
      eligibleTargets: [],
    });
    expect(jev).not.toHaveBeenCalled();
  });

  it("suggests only unresolved inherited targets and uses effective inherited basis", async () => {
    const jev = jevPortPicking("electrical:");
    const fieldResolutions = {
      projectId: {
        mode: "inherit" as const,
        storedValue: null,
        value: "PRJ-AAAA",
        fallbackValue: "PRJ-AAAA",
        source: "Parent task",
        sourceEntity: { entityType: "task" as const, entityId: "TSK-PARENT" },
        matchesFallback: true,
        canReset: false,
      },
      trade: {
        mode: "inherit" as const,
        storedValue: null,
        value: null,
        fallbackValue: null,
        source: "No trade source",
        sourceEntity: null,
        matchesFallback: true,
        canReset: false,
      },
    };
    const result = await suggestFields(
      fakeDb,
      {
        basisMode: "suggested",
        entity: "task",
        targets: ["projectId", "trade"],
        basis: { name: "replace panel", projectId: null },
      },
      {
        jev,
        resolveInheritance: async () => fieldResolutions,
        resolveLabels: async () => new Map([["PRJ-AAAA", "Kitchen Remodel"]]),
        registry: { "task.projectId": fakeProjectSpec() },
      },
    );

    expect(result.eligibleTargets).toEqual(["trade"]);
    expect(result.suggestions.projectId).toBeUndefined();
    expect(result.suggestions.trade?.value).toBe("electrical");
    // (g) an inheritance-ineligible target is never asked either.
    expect(result.outcomes?.projectId).toEqual({
      kind: "skipped",
      reason: "resolved",
    });
    expect(jev.mock.calls[0]?.[0].state).toContain("Kitchen Remodel");
  });

  it("allows provided alternatives for explicit None without using a sibling proposal as evidence", async () => {
    const jev = jevPortPicking("Kitchen Remodel", "electrical:");
    const fieldResolutions = {
      projectId: {
        mode: "none" as const,
        storedValue: null,
        value: null,
        fallbackValue: "PRJ-BBBB",
        source: "Task override",
        sourceEntity: null,
        matchesFallback: false,
        canReset: true,
      },
      trade: {
        mode: "inherit" as const,
        storedValue: null,
        value: null,
        fallbackValue: null,
        source: "No trade source",
        sourceEntity: null,
        matchesFallback: true,
        canReset: false,
      },
    };
    const result = await suggestFields(
      fakeDb,
      {
        basisMode: "provided",
        entity: "task",
        targets: ["projectId", "trade"],
        basis: { name: "replace panel", projectId: null },
      },
      {
        jev,
        resolveInheritance: async () => fieldResolutions,
        resolveLabels: async () => new Map([["PRJ-AAAA", "Kitchen Remodel"]]),
        registry: { "task.projectId": fakeProjectSpec() },
      },
    );

    expect(result.eligibleTargets).toEqual(["projectId", "trade"]);
    expect(result.suggestions.projectId?.value).toBe("PRJ-AAAA");
    const tradeCall = jev.mock.calls.find(([call]) =>
      Object.values(call.questions.selection.criteria).some((label) =>
        label.startsWith("electrical:"),
      ),
    );
    expect(tradeCall?.[0].state).not.toContain("Kitchen Remodel");
  });

  it("chains an untouched unresolved suggested project into an unresolved trade", async () => {
    const jev = jevPortPicking("Kitchen Remodel", "electrical:");
    const unresolved = {
      mode: "inherit" as const,
      storedValue: null,
      value: null,
      fallbackValue: null,
      source: "No source",
      sourceEntity: null,
      matchesFallback: true,
      canReset: false,
    };
    const result = await suggestFields(
      fakeDb,
      {
        basisMode: "suggested",
        entity: "task",
        targets: ["projectId", "trade"],
        basis: { name: "replace panel", projectId: null },
      },
      {
        jev,
        resolveInheritance: async () => ({
          projectId: unresolved,
          trade: unresolved,
        }),
        resolveLabels: async () => new Map([["PRJ-AAAA", "Kitchen Remodel"]]),
        registry: { "task.projectId": fakeProjectSpec() },
      },
    );

    expect(result.eligibleTargets).toEqual(["projectId", "trade"]);
    expect(result.suggestions.projectId?.value).toBe("PRJ-AAAA");
    expect(result.suggestions.trade?.value).toBe("electrical");
    const tradeCall = jev.mock.calls.find(([call]) =>
      Object.values(call.questions.selection.criteria).some((label) =>
        label.startsWith("electrical:"),
      ),
    );
    expect(tradeCall?.[0].state).toContain("Kitchen Remodel");
  });

  it("chains a resolved target's value into a sibling target's basis, uses a client value when sent, and carries the resolved display name into the sibling's subject", async () => {
    const jev = jevPortPicking("Kitchen Remodel", "electrical:");
    const resolveLabels = vi.fn(
      async (_db: Database, codes: readonly string[]) => {
        const byCode = new Map<string, string>();
        for (const code of codes) {
          byCode.set(
            code,
            code === "PRJ-EXPLICIT" ? "Explicit Project" : "Kitchen Remodel",
          );
        }
        return byCode;
      },
    );

    // `projectId: null` — the request's own `projectId` target hasn't been
    // given a client value, so `trade` (whose basis includes `projectId`)
    // must chain the value `projectId` itself just resolved.
    const chained = await suggestFields(
      fakeDb,
      {
        basisMode: "suggested",
        entity: "expense",
        targets: ["projectId", "trade"],
        basis: { name: "panel upgrade", projectId: null },
      },
      {
        jev,
        resolveLabels,
        registry: { "expense.projectId": fakeProjectSpec() },
      },
    );
    expect(chained.suggestions.projectId?.value).toBe("PRJ-AAAA");
    expect(chained.suggestions.trade?.value).toBe("electrical");
    // The reference basis key resolved to its display name before being
    // rendered into the sibling target's subject.
    const tradeCall = jev.mock.calls.at(-1)?.[0];
    expect(tradeCall?.state).toContain('Project: "Kitchen Remodel"');

    // A client-supplied `projectId` wins over the sibling target's own
    // resolution, even though `projectId` is requested in the same call.
    const explicitJev = jevPortPicking("Deck Build", "electrical:");
    const explicit = await suggestFields(
      fakeDb,
      {
        basisMode: "suggested",
        entity: "expense",
        targets: ["projectId", "trade"],
        basis: { name: "panel upgrade", projectId: "PRJ-EXPLICIT" },
      },
      {
        jev: explicitJev,
        resolveLabels,
        registry: { "expense.projectId": fakeProjectSpec() },
      },
    );
    expect(explicit.suggestions.trade?.value).toBe("electrical");
    const explicitTradeCall = explicitJev.mock.calls.at(-1)?.[0];
    expect(explicitTradeCall?.state).toContain('Project: "Explicit Project"');
  });
});
