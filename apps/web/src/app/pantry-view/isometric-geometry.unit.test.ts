import { describe, expect, it } from "vitest";
import {
  adjustLight,
  calculateZoomToFit,
  pointInPolygon,
  toScreen,
} from "./isometric-geometry";

describe("isometric geometry", () => {
  it("projects grid coordinates consistently", () => {
    expect(toScreen(2, 1, 1, 100, 50)).toEqual({ x: 128, y: 66 });
  });

  it("clamps shaded HSL lightness", () => {
    expect(adjustLight("hsl(42, 20%, 95%)", 12)).toBe("hsl(42, 20%, 100%)");
  });

  it("hit-tests convex polygons", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
  });

  it("fits room bounds within configured zoom limits", () => {
    const camera = calculateZoomToFit(
      [{ originX: 0, originY: 0, roomW: 8, roomD: 6 }],
      800,
      600,
    );
    expect(camera.zoom).toBeGreaterThanOrEqual(0.08);
    expect(camera.zoom).toBeLessThanOrEqual(2.5);
  });
});
