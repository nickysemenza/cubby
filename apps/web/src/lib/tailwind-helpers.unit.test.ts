import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("should merge tailwind classes correctly", () => {
    expect(cn("px-4", "py-2")).toBe("px-4 py-2");
  });

  it("should handle conflicting classes by using the last one", () => {
    expect(cn("px-4", "px-8")).toBe("px-8");
  });

  it("should handle conditional classes", () => {
    expect(cn("px-4", true && "py-2", false && "py-4")).toBe("px-4 py-2");
  });

  it("should handle arrays of classes", () => {
    expect(cn(["px-4", "py-2"], "bg-red-500")).toBe("px-4 py-2 bg-red-500");
  });

  it("should handle empty inputs", () => {
    expect(cn()).toBe("");
    expect(cn("", null, undefined)).toBe("");
  });
});
