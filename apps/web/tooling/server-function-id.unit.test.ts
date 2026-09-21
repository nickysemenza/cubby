import { describe, expect, it } from "vitest";
import { createServerFunctionIdGenerator } from "./server-function-id";

const detailFunction = {
  filename: "src/entities/entity-detail.functions.ts",
  functionName: "getEntityDetailTransport_createServerFn_handler",
};

describe("generateServerFunctionId", () => {
  it("builds a readable, URL-safe production id", () => {
    const generateServerFunctionId = createServerFunctionIdGenerator();
    const id = generateServerFunctionId(detailFunction);

    expect(id).toBe("entities-entity-detail-get-entity-detail");
    expect(id).toMatch(/^[a-z\d-]+$/u);
    expect(id).not.toMatch(/^(?:[a-f\d]{40,}|[A-Za-z\d_-]{80,})$/u);
  });

  it("is stable across worktree roots, path separators, and Vite suffixes", () => {
    const generateServerFunctionId = createServerFunctionIdGenerator();
    const expected = generateServerFunctionId(detailFunction);

    expect(
      generateServerFunctionId({
        ...detailFunction,
        filename:
          "/Users/example/.codex/worktrees/test/cubby/apps/web/src/entities/entity-detail.functions.ts?server-fn-split",
      }),
    ).toBe(expected);
    expect(
      generateServerFunctionId({
        ...detailFunction,
        filename:
          "C:\\repo\\apps\\web\\src\\entities\\entity-detail.functions.ts",
      }),
    ).toBe(expected);
  });

  it("keeps same-name functions in different modules distinct", () => {
    const generateServerFunctionId = createServerFunctionIdGenerator();
    const ids = [
      generateServerFunctionId(detailFunction),
      generateServerFunctionId({
        ...detailFunction,
        filename: "src/images/entity-detail.functions.ts",
      }),
      generateServerFunctionId({
        ...detailFunction,
        functionName: "getEntityDetailTransport_createServerFn_handler_1",
      }),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("throws instead of silently suffixing a semantic collision", () => {
    const generateServerFunctionId = createServerFunctionIdGenerator();
    generateServerFunctionId({
      filename: "src/entities/entity_detail.functions.ts",
      functionName: detailFunction.functionName,
    });

    expect(() =>
      generateServerFunctionId({
        filename: "src/entities/entity-detail.functions.ts",
        functionName: detailFunction.functionName,
      }),
    ).toThrow(/Server function id collision/u);
  });
});
