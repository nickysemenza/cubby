import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { listOverrides } from ".";
import type { ListOverrideContext } from "./types";

// Regression: the product override keyed its column memos on mutation result
// objects, which are new every render. `overrides`/`compose` key the list's
// column memo, so every list re-render rebuilt every column and remounted every
// cell — a row-checkbox click landing mid-remount never toggled.
let harness: ReturnType<typeof createBrowserTestHarness> | undefined;
afterEach(() => harness?.dispose());

const context: ListOverrideContext = {
  search: {},
  navigate: () => undefined,
};

describe("list overrides", () => {
  it.each(Object.entries(listOverrides))(
    "%s keeps its column parts referentially stable across renders",
    async (_entity, override) => {
      harness = createBrowserTestHarness({ initialPath: "/" });
      await harness.loadRouter();
      const { result, rerender } = renderHook(() => override.use(context), {
        wrapper: harness.routerWrapper,
      });
      const first = result.current;
      rerender();
      expect(result.current.overrides).toBe(first.overrides);
      expect(result.current.compose).toBe(first.compose);
    },
  );
});
