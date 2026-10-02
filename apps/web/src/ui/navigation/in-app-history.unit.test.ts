import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { createInAppHistory } from "./in-app-history";

describe("known in-app history", () => {
  it("does not treat pre-existing history as an in-app predecessor", () => {
    const history = createMemoryHistory({
      initialEntries: ["/auth/sign-in", "/products/PRD-AAAA"],
    });
    expect(createInAppHistory(history).getSnapshot()).toBe(false);
  });

  it("preserves search replacements and follows back, forward, and new branches", () => {
    const history = createMemoryHistory({ initialEntries: ["/search"] });
    const known = createInAppHistory(history);
    const unsubscribe = known.subscribe(() => {});
    history.replace("/search?q=flour");
    expect(known.getSnapshot()).toBe(false);
    history.push("/products/PRD-AAAA");
    expect(known.getSnapshot()).toBe(true);
    history.back();
    expect(history.location.href).toBe("/search?q=flour");
    expect(known.getSnapshot()).toBe(false);
    history.forward();
    expect(known.getSnapshot()).toBe(true);
    history.back();
    history.push("/recipes");
    expect(known.getSnapshot()).toBe(true);
    unsubscribe();
  });
});
