import { describe, expect, it } from "vitest";

import { graphScrollTarget, overviewScale } from "./dependency-graph-viewport";

describe("graph viewport geometry", () => {
  for (const width of [320, 768, 1440]) {
    for (const graph of [
      { x: 0, y: 0, width: 200, height: 100 },
      { x: 0, y: 0, width: 12000, height: 600 },
      { x: 0, y: 0, width: 600, height: 16000 },
      { x: 0, y: 0, width: 6000, height: 6000 },
    ]) {
      it(`fits ${graph.width}x${graph.height} into ${width}px without cropping`, () => {
        const viewport = { x: 0, y: 0, width, height: 480 };
        const scale = overviewScale(graph, viewport);
        expect(scale).toBeGreaterThan(0);
        expect(scale).toBeLessThanOrEqual(1);
        expect(graph.width * scale).toBeLessThanOrEqual(width);
        expect(graph.height * scale).toBeLessThanOrEqual(viewport.height);
        const target = { x: 4000, y: 8000, width: 220, height: 100 };
        const scroll = graphScrollTarget(target, viewport);
        expect(scroll.left).toBeLessThanOrEqual(target.x);
        expect(scroll.left + width).toBeGreaterThanOrEqual(
          target.x + target.width,
        );
        expect(scroll.top).toBeLessThan(target.y);
        expect(scroll.top + viewport.height).toBeGreaterThan(
          target.y + target.height,
        );
      });
    }
  }
  it("starts a large group at its heading rather than its empty center", () => {
    expect(
      graphScrollTarget(
        { x: 100, y: 100, width: 8000, height: 16000 },
        { x: 0, y: 0, width: 320, height: 480 },
      ),
    ).toEqual({ left: 76, top: 52 });
  });
});
