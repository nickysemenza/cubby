import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  // `cn` is just `twMerge(clsx(...))` — clsx/tailwind-merge own their own test
  // suites. One smoke test proves both are wired: clsx drops the falsy arg and
  // flattens the array, tailwind-merge dedupes the conflicting `px-*`.
  it("flattens conditionals/arrays (clsx) and dedupes conflicts (twMerge)", () => {
    expect(cn(["px-4"], false && "px-2", "px-8")).toBe("px-8");
  });
});
