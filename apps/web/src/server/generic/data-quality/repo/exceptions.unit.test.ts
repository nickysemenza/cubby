import {
  dataCheck,
  dataCheckEntity,
  dataCheckExemptible,
  dataQualityExceptionEntities,
} from "@cubby/schemas/data-quality";
import { describe, expect, it } from "vitest";

import { exceptionReasonsFor } from "./exception-reasons";

describe("data exception reasons", () => {
  // A check absent from EXCEPTION_REASONS admits no reason, so its gap could
  // never be closed even when the fact provably does not exist. A check that
  // truly cannot be excepted must say so with `exceptions: "forbidden"` in its
  // declaration rather than silently lacking a reason list.
  it("gives every exemptible check on an exceptions-enabled entity a reason", () => {
    const withoutReasons = dataCheck.options.filter(
      (check) =>
        dataQualityExceptionEntities[dataCheckEntity[check]] &&
        dataCheckExemptible[check] &&
        exceptionReasonsFor(check).length === 0,
    );
    expect(withoutReasons).toEqual([]);
  });
});
