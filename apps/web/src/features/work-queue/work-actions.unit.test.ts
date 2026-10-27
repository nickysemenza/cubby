import { describe, expect, it } from "vitest";

import { problemQueryDeclarations } from "~/entity/problems/problem-registry";
import { featureRegistry } from "~/entity/feature-registry";
import { installFeatures } from "~/features/registry";

// Failure mode: a Problem declares a remediation the queue renders nothing
// for, because no feature performs its namespaced action id.
describe("workActions", () => {
  it("performs every declared Problem action", () => {
    installFeatures();
    const declared = problemQueryDeclarations().flatMap((definition) =>
      definition.actions.map((action) => `${definition.key}:${action.id}`),
    );
    expect(declared.length).toBeGreaterThan(0);
    const handlers = featureRegistry().workActions;
    expect(declared.filter((id) => !(id in handlers))).toEqual([]);
  });
});
