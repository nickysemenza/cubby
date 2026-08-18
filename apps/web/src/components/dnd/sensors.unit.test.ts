import { describe, expect, it, vi } from "vitest";
import {
  createValidTargetKeyboardCoordinates,
  resolveActivatorDistance,
} from "./sensors";

describe("resolveActivatorDistance", () => {
  it("gives resize handles immediate mouse activation", () => {
    expect(resolveActivatorDistance(true, "12")).toBe("immediate");
  });

  it("accepts a surface-specific movement threshold", () => {
    expect(resolveActivatorDistance(false, "4")).toBe(4);
    expect(resolveActivatorDistance(false, "nope")).toBeUndefined();
    expect(resolveActivatorDistance(false, "-1")).toBeUndefined();
  });
});

describe("createValidTargetKeyboardCoordinates", () => {
  it("moves to the nearest valid target in the requested direction", () => {
    const preventDefault = vi.fn();
    const coordinateGetter = createValidTargetKeyboardCoordinates(
      (_active, target) => target?.valid === true,
    );
    const rects = new Map([
      ["invalid-near", { left: 20, top: 0, width: 10, height: 10 }],
      ["valid", { left: 40, top: 0, width: 10, height: 10 }],
      ["valid-far", { left: 80, top: 0, width: 10, height: 10 }],
    ]);
    const containers = [
      { id: "invalid-near", data: { current: { valid: false } } },
      { id: "valid", data: { current: { valid: true } } },
      { id: "valid-far", data: { current: { valid: true } } },
    ];

    const result = coordinateGetter(
      { code: "ArrowRight", preventDefault } as never,
      {
        currentCoordinates: { x: 5, y: 7 },
        context: {
          active: { data: { current: {} } },
          collisionRect: { left: 0, top: 0, width: 10, height: 10 },
          droppableContainers: { getEnabled: () => containers },
          droppableRects: rects,
        },
      } as never,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result).toEqual({ x: 45, y: 7 });
  });
});
