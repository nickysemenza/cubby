import type { WAvailabilityGroup } from "@cubby/recipebridge";
import { describe, expect, it } from "vitest";

import {
  evaluateAvailability,
  toWAmount,
  toWProductInput,
} from "./recipe-costing";
import { cups, g, makeProduct } from "./recipe-costing.fixtures";

/**
 * The ok/short/missing/unconvertible classification and the unit conversion
 * behind it are recipebridge's, not TypeScript's — `AvailabilityService` only
 * assembles groups, calls the engine, and reshapes the result.
 *
 * Those four verdicts had no unit coverage at all: the only tests exercising
 * them went through the full browser transport in
 * services/availability.integration.test.ts, seeding a product, a mapping, an
 * inventory entry and a recipe to reach a pure function. Those integration
 * tests stay — they cover the assembly and the `coverage`/`missing` rollup the
 * engine does not produce — but the kernel itself belongs here.
 */
const flourWithCupMapping = makeProduct("flour", {
  // 1 cup = 120 g, so a 2-cup need is 240 g.
  mappings: [{ a: cups(1), b: g(120) }],
});

const group = (need: ReturnType<typeof cups>, onHand: ReturnType<typeof g>[]) =>
  ({
    key: "flour",
    needs: [{ amount: toWAmount(need), line_index: 0 }],
    products: [
      {
        product: toWProductInput(flourWithCupMapping),
        on_hand: onHand.map(toWAmount),
      },
    ],
  }) satisfies WAvailabilityGroup;

const evaluateOne = (g_: WAvailabilityGroup) =>
  evaluateAvailability({ groups: [g_] }).groups[0]!;

describe("evaluateAvailability classification", () => {
  it("reports ok when on-hand covers the need, converting cups to the basis unit", () => {
    const result = evaluateOne(group(cups(2), [g(500)]));

    expect(result.status).toBe("ok");
    expect(result.basis_unit).toBe("g");
    expect(result.need_value).toBeCloseTo(240, 1);
    expect(result.have_value).toBeCloseTo(500, 1);
  });

  it("reports short when on-hand is under the need, and states the shortfall", () => {
    const result = evaluateOne(group(cups(2), [g(100)]));

    expect(result.status).toBe("short");
    expect(result.need_value).toBeCloseTo(240, 1);
    expect(result.have_value).toBeCloseTo(100, 1);
    expect(result.shortfall).toBeCloseTo(140, 1);
  });

  it("reports missing when nothing is on hand", () => {
    const result = evaluateOne(group(cups(2), []));

    expect(result.status).toBe("missing");
    expect(result.have_value ?? null).toBeNull();
  });

  it("reports unconvertible when no mapping reaches the needed unit", () => {
    const result = evaluateOne({
      ...group(cups(2), []),
      products: [
        {
          product: toWProductInput(flourWithCupMapping),
          // On hand in "widget"; the only mapping is cup<->g, so there is no
          // path to the need's unit.
          on_hand: [toWAmount({ value: 3, unit: "widget" })],
        },
      ],
    });

    expect(result.status).toBe("unconvertible");
    expect(result.have_value ?? null).toBeNull();
  });

  it("sums multiple on-hand amounts before classifying", () => {
    const result = evaluateOne(group(cups(2), [g(150), g(150)]));

    expect(result.status).toBe("ok");
    expect(result.have_value).toBeCloseTo(300, 1);
  });
});
