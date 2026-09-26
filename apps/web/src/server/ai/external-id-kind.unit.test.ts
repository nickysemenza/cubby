import type { ExternalIdKindSuggestionInput } from "@cubby/schemas/ai";
import { runEntityId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import { suggestExternalIdKind } from "~/server/ai/external-id-kind";
import type { JevPort } from "~/server/ai/jev";
import type { AiRunContext } from "~/server/ai/run-feature";

type JevInput = Parameters<JevPort>[0];

/** Picks whichever criterion's rendered label contains `needle`, filling the
 * rest so `validateProbabilities` (`jev.ts`) accepts the response — same
 * shape as `suggest-fields.unit.test.ts`'s fake port. */
function jevPortPicking(needle: string) {
  return vi.fn(async (input: JevInput) => {
    const entries = Object.entries(input.questions.selection.criteria);
    const match = entries.find(([, label]) => label.includes(needle));
    const [choiceKey] = match ?? entries[0]!;
    const rest = entries.filter(([key]) => key !== choiceKey);
    const winnerProbability = 0.9;
    const each = rest.length > 0 ? (1 - winnerProbability) / rest.length : 0;
    return {
      answers: {
        selection: {
          type: "choice" as const,
          choice: choiceKey,
          confidence: winnerProbability,
          probabilities: Object.fromEntries([
            [choiceKey, winnerProbability],
            ...rest.map(([key]) => [key, each] as const),
          ]),
        },
      },
    };
  });
}

const usage: AiRunContext = {
  operation: "test",
  cacheStatus: "none",
  runId: runEntityId.parse("00000000-0000-4000-8000-000000000001"),
};

function inputFor(
  overrides: Partial<ExternalIdKindSuggestionInput>,
): ExternalIdKindSuggestionInput {
  return {
    source: "amazon",
    identifier: "B08N5WRWNW",
    url: null,
    productName: null,
    manufacturer: null,
    ...overrides,
  };
}

describe("suggestExternalIdKind", () => {
  describe("regex fast paths", () => {
    it("recognizes an Amazon ASIN without calling Jev", async () => {
      const jev: JevPort = vi.fn();
      const result = await suggestExternalIdKind(
        inputFor({ source: "amazon", identifier: "B08N5WRWNW" }),
        usage,
        { jev },
      );

      expect(jev).not.toHaveBeenCalled();
      expect(result).toMatchObject({ value: "asin", probability: 1 });
    });

    it("recognizes an 8-14 digit barcode as gtin_14 without calling Jev", async () => {
      const jev: JevPort = vi.fn();
      const result = await suggestExternalIdKind(
        inputFor({ source: "mcmaster", identifier: "012345678905" }),
        usage,
        { jev },
      );

      expect(jev).not.toHaveBeenCalled();
      expect(result).toMatchObject({ value: "gtin_14", probability: 1 });
    });

    it("recognizes Home Depot's 9-digit internet number without calling Jev", async () => {
      const jev: JevPort = vi.fn();
      const result = await suggestExternalIdKind(
        inputFor({ source: "home-depot", identifier: "123456789" }),
        usage,
        { jev },
      );

      expect(jev).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        value: "internet_number",
        probability: 1,
      });
    });

    it("still treats a 9-digit Home Depot barcode as gtin_14 outside that one length exception", async () => {
      const jev: JevPort = vi.fn();
      const result = await suggestExternalIdKind(
        inputFor({ source: "home-depot", identifier: "12345678" }),
        usage,
        { jev },
      );

      expect(jev).not.toHaveBeenCalled();
      expect(result).toMatchObject({ value: "gtin_14", probability: 1 });
    });
  });

  describe("Jev classification", () => {
    it("classifies a non-shape identifier over the six non-legacy kinds", async () => {
      const jev = jevPortPicking("catalog_number");
      const result = await suggestExternalIdKind(
        inputFor({
          source: "mcmaster",
          identifier: "91251A537",
          productName: "1/4-20 hex bolt",
        }),
        usage,
        { jev },
      );

      expect(jev).toHaveBeenCalledTimes(1);
      expect(result?.value).toBe("catalog_number");
    });

    it("never offers legacy_unspecified as a choice", async () => {
      const jev = jevPortPicking("retailer_sku");
      let seenChoices: string[] = [];
      const capturingJev: JevPort = async (input) => {
        seenChoices = Object.values(input.questions.selection.criteria);
        return jev(input);
      };

      await suggestExternalIdKind(
        inputFor({ source: "target", identifier: "50-1234567" }),
        usage,
        { jev: capturingJev },
      );

      expect(
        seenChoices.some((choice) => choice.includes("legacy_unspecified")),
      ).toBe(false);
    });
  });
});
