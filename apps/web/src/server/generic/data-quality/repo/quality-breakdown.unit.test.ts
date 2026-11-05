import {
  dataCheck,
  dataCheckEntity,
  dataCheckExemptible,
  dataCheckKind,
  dataCheckLabel,
  dataCheckAssessed,
  dataChecksByEntity,
  dataQualityExceptionEntities,
  isDefectDataCheck,
} from "@cubby/schemas/data-quality";
import { describe, expect, it } from "vitest";

import { exceptionReasonsFor } from "./exception-reasons";
import { buildQualityBreakdown } from "./hydrate";

// The explanation must use applicability, rather than all declared checks;
// active exceptions satisfy a check, stale exceptions do not, and unrelated
// gaps must never reduce this record's score.
describe("quality explanation calculation", () => {
  const first = dataChecksByEntity.product.enum.product_category;
  const second = dataChecksByEntity.product.enum.product_image;

  it("distinguishes accepted gaps from stale exceptions", () => {
    const result = buildQualityBreakdown([first, second], [second], [first]);
    expect(result.checks.map((check) => check.state)).toEqual([
      "excepted",
      "gap",
    ]);
  });

  it("does not assess a record with no applicable checks", () => {
    const result = buildQualityBreakdown([], [first], []);
    expect(result).toMatchObject({
      status: "not_assessed",
      checks: [],
    });
  });

  it("names what is missing in the summary, including a diagnostic", () => {
    const diagnostic = dataCheck.options.find(
      (check) => !dataCheckAssessed[check] && isDefectDataCheck(check),
    );
    if (!diagnostic) throw new Error("Expected a diagnostic defect check");
    const alone = buildQualityBreakdown([diagnostic], [diagnostic], []);
    expect(alone.status).toBe("defect");
    expect(alone.summary).toBe(`1 unresolved: ${dataCheckLabel[diagnostic]}.`);
  });

  it("marks a record complete only through accepted exceptions", () => {
    const result = buildQualityBreakdown([first, second], [], [second]);
    expect(result).toMatchObject({
      status: "complete_with_exceptions",
    });
    expect(result.summary).toContain("accepted exceptions count as satisfied");
  });

  // The display wording lives here only; web and native render these strings,
  // so a state/kind pair mapped to the wrong label would show on both.
  it("serves the summary and per-check labels clients render verbatim", () => {
    const defect = dataCheck.options.find(
      (check) => dataCheckKind[check] === "defect",
    )!;
    const missing = dataCheck.options.find(
      (check) => dataCheckKind[check] === "missing",
    )!;
    const result = buildQualityBreakdown(
      [defect, missing],
      [defect, missing],
      [],
    );
    expect(result.checks.map((check) => check.stateLabel)).toEqual([
      "Defect",
      "Missing data",
    ]);
    expect(result.summary).toContain("unresolved:");
    const satisfied = buildQualityBreakdown([missing], [], []);
    expect(satisfied.checks[0]!.stateLabel).toBe("Satisfied");
    expect(satisfied.checks[0]!.weightLabel).toBe(
      dataCheckAssessed[missing] ? "Check" : "Diagnostic",
    );
    const excepted = buildQualityBreakdown([missing], [], [missing]);
    expect(excepted.checks[0]!.stateLabel).toBe("Accepted exception");
    expect(buildQualityBreakdown([], [], []).summary).toBe(
      "No applicable checks: quality is not assessed.",
    );
  });

  // Clients render the accept action from this list instead of restating the
  // server's allowed reasons, so a check that forbids exceptions must expose
  // none and an exemptible one must expose exactly the server's list.
  it("exposes the server's reason list only for exemptible checks", () => {
    const forbidden = dataCheck.options.find(
      (check) =>
        dataQualityExceptionEntities[dataCheckEntity[check]] &&
        !dataCheckExemptible[check],
    );
    expect(forbidden).toBeDefined();
    const result = buildQualityBreakdown(
      [first, forbidden!],
      [first, forbidden!],
      [],
    );
    expect(
      result.checks.map((check) =>
        check.exceptionReasons.map(({ reason }) => reason),
      ),
    ).toEqual([[...exceptionReasonsFor(first)], []]);
    expect(result.checks[0]!.exceptionReasons.length).toBeGreaterThan(0);
  });

  it("carries the recorded exception so a stale one can be cleared", () => {
    const stale = {
      check: second,
      reason: "unavailable",
      note: "Synthetic.",
      targetType: "product",
      targetId: "PRD-4K7M",
      state: "stale",
    } as const;
    const result = buildQualityBreakdown([second], [second], [], [stale]);
    expect(result.checks[0]).toMatchObject({
      state: "gap",
      exception: { reason: "unavailable", note: "Synthetic.", state: "stale" },
    });
  });
});
