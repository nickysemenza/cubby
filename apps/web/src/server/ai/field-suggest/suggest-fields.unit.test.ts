import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { describe, expect, it, vi } from "vitest";

import type {
  FieldSuggestSpec,
  ReferenceSuggestSpec,
} from "~/server/ai/field-suggest/registry";
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
        });
      },
    },
    {
      name: "an all-null basis resolves to null without calling the model",
      entity: "product",
      targets: ["category"],
      basis: {},
      jev: jevPortPicking("food:"),
      assert: (out, jev) => {
        expect(out.suggestions.category).toBeNull();
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
