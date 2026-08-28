import { describe, expect, it } from "vitest";

import {
  centerBoxRect,
  clampRectToSize,
  computeScanRoi,
  mapDisplayRectToSource,
  objectFitScale,
  pickMostCentralDetection,
  shouldDetectNow,
} from "./scan-roi";

const closeTo = (rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}) =>
  ({
    x: expect.closeTo(rect.x, 3),
    y: expect.closeTo(rect.y, 3),
    width: expect.closeTo(rect.width, 3),
    height: expect.closeTo(rect.height, 3),
  }) as const;

describe("objectFitScale", () => {
  it("cover takes the larger axis ratio, contain the smaller", () => {
    const source = { width: 1280, height: 720 };
    const display = { width: 400, height: 300 };
    expect(objectFitScale(source, display, "cover")).toBeCloseTo(300 / 720, 6);
    expect(objectFitScale(source, display, "contain")).toBeCloseTo(
      400 / 1280,
      6,
    );
  });

  it("is 0 for a video that hasn't reported its intrinsic size yet", () => {
    expect(
      objectFitScale(
        { width: 0, height: 0 },
        { width: 400, height: 300 },
        "cover",
      ),
    ).toBe(0);
    expect(
      objectFitScale(
        { width: 1280, height: 720 },
        { width: 0, height: 0 },
        "cover",
      ),
    ).toBe(0);
  });
});

describe("mapDisplayRectToSource — cover", () => {
  it("maps a reticle through a horizontally-cropped cover frame", () => {
    const roi = mapDisplayRectToSource(
      { x: 30, y: 94, width: 340, height: 112 },
      { width: 1280, height: 720 },
      { width: 400, height: 300 },
      "cover",
    );
    expect(roi).toEqual(
      closeTo({ x: 232, y: 225.6, width: 816, height: 268.8 }),
    );
  });

  it("maps a reticle through a vertically-cropped cover frame", () => {
    const roi = mapDisplayRectToSource(
      { x: 0, y: 100, width: 400, height: 100 },
      { width: 720, height: 1280 },
      { width: 400, height: 300 },
      "cover",
    );
    expect(roi).toEqual(closeTo({ x: 0, y: 550, width: 720, height: 180 }));
  });

  it("is the identity when the display box matches the source aspect exactly", () => {
    const roi = mapDisplayRectToSource(
      { x: 100, y: 50, width: 200, height: 100 },
      { width: 640, height: 480 },
      { width: 640, height: 480 },
      "cover",
    );
    expect(roi).toEqual(closeTo({ x: 100, y: 50, width: 200, height: 100 }));
  });
});

describe("mapDisplayRectToSource — contain", () => {
  // 16:9 frame letterboxed into a square box: 87.5px of empty band top and
  // bottom, so display y must have that band subtracted before scaling.
  it("subtracts the letterbox band", () => {
    const roi = mapDisplayRectToSource(
      { x: 40, y: 150, width: 320, height: 100 },
      { width: 1280, height: 720 },
      { width: 400, height: 400 },
      "contain",
    );
    expect(roi).toEqual(closeTo({ x: 128, y: 200, width: 1024, height: 320 }));
  });

  it("maps the letterbox band itself to negative source coordinates", () => {
    const roi = mapDisplayRectToSource(
      { x: 0, y: 0, width: 400, height: 400 },
      { width: 1280, height: 720 },
      { width: 400, height: 400 },
      "contain",
    );
    expect(roi).toEqual(closeTo({ x: 0, y: -280, width: 1280, height: 1280 }));
    expect(clampRectToSize(roi, { width: 1280, height: 720 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });

  it("maps a pillarboxed (portrait-in-landscape) contain frame", () => {
    const roi = mapDisplayRectToSource(
      { x: 115.625, y: 0, width: 168.75, height: 300 },
      { width: 720, height: 1280 },
      { width: 400, height: 300 },
      "contain",
    );
    expect(roi).toEqual(closeTo({ x: 0, y: 0, width: 720, height: 1280 }));
  });
});

describe("clampRectToSize", () => {
  it("keeps the visible part in place when the rect hangs off the top-left", () => {
    expect(
      clampRectToSize(
        { x: -100, y: -50, width: 400, height: 200 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });

  it("trims at the bottom-right edge", () => {
    expect(
      clampRectToSize(
        { x: 1180, y: 660, width: 400, height: 200 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 1180, y: 660, width: 100, height: 60 });
  });

  it("returns a zero-size rect for a rect entirely outside the frame", () => {
    expect(
      clampRectToSize(
        { x: 2000, y: 10, width: 100, height: 100 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 1280, y: 10, width: 0, height: 100 });
  });

  it("returns a zero rect for a degenerate frame", () => {
    expect(
      clampRectToSize(
        { x: 0, y: 0, width: 10, height: 10 },
        { width: 0, height: 0 },
      ),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("rounds to whole pixels (drawImage source rects are pixel-addressed)", () => {
    expect(
      clampRectToSize(
        { x: 10.4, y: 10.6, width: 100.4, height: 100.4 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 10, y: 11, width: 101, height: 100 });
  });
});

describe("centerBoxRect", () => {
  it("centers a fractional box in the display", () => {
    expect(centerBoxRect({ width: 400, height: 300 }, 0.85, 0.4)).toEqual({
      x: 30,
      y: 90,
      width: 340,
      height: 120,
    });
  });
});

describe("computeScanRoi", () => {
  const source = { width: 1280, height: 720 };
  const display = { width: 400, height: 300 };
  const reticle = { x: 30, y: 94, width: 340, height: 112 };

  it("crops the reticle region out of a cover-fitted frame", () => {
    expect(
      computeScanRoi({ source, display, reticle, padFraction: 0 }),
    ).toEqual({
      x: 232,
      y: 226,
      width: 816,
      height: 268,
    });
  });

  it("pads the crop so a barcode grazing the guide still decodes", () => {
    const padded = computeScanRoi({ source, display, reticle });
    const tight = computeScanRoi({ source, display, reticle, padFraction: 0 });
    expect(padded?.width).toBeGreaterThan(tight?.width ?? 0);
    expect(padded?.height).toBeGreaterThan(tight?.height ?? 0);
    // Padding never escapes the frame.
    expect(padded?.x).toBeGreaterThanOrEqual(0);
    expect((padded?.x ?? 0) + (padded?.width ?? 0)).toBeLessThanOrEqual(1280);
  });

  it("clamps a reticle that overhangs the cropped axis", () => {
    // Full-bleed reticle on a cover frame: the display box is narrower than the
    // painted frame, so the crop must stay inside the source width.
    const roi = computeScanRoi({
      source,
      display,
      reticle: { x: 0, y: 0, width: 400, height: 300 },
      padFraction: 0.2,
    });
    expect(roi).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("returns null before the video reports its intrinsic size", () => {
    expect(
      computeScanRoi({ source: { width: 0, height: 0 }, display, reticle }),
    ).toBeNull();
  });

  it("returns null for a reticle too small to hold a barcode", () => {
    expect(
      computeScanRoi({
        source,
        display,
        reticle: { x: 200, y: 150, width: 2, height: 2 },
        padFraction: 0,
      }),
    ).toBeNull();
  });
});

describe("pickMostCentralDetection", () => {
  const roi = { width: 800, height: 260 };
  const box = (x: number, y: number) => ({
    boundingBox: { x, y, width: 100, height: 40 },
  });

  it("picks the detection nearest the ROI center, not the first result", () => {
    const edge = box(10, 10);
    const centered = box(350, 110);
    const other = box(600, 200);
    expect(pickMostCentralDetection([edge, centered, other], roi)).toBe(
      centered,
    );
  });

  it("returns null for no detections", () => {
    expect(pickMostCentralDetection([], roi)).toBeNull();
  });

  it("still returns a lone detection with no bounding box", () => {
    const only = { boundingBox: null };
    expect(pickMostCentralDetection([only], roi)).toBe(only);
  });

  it("prefers a positioned detection over an unpositioned one", () => {
    const unpositioned = { boundingBox: null };
    const positioned = box(600, 200);
    expect(pickMostCentralDetection([unpositioned, positioned], roi)).toBe(
      positioned,
    );
  });
});

describe("shouldDetectNow", () => {
  it("gates the loop to the detection interval", () => {
    expect(shouldDetectNow(1000, 950, 90)).toBe(false);
    expect(shouldDetectNow(1040, 950, 90)).toBe(true);
    expect(shouldDetectNow(1040, 950)).toBe(true);
  });

  it("always runs the first frame", () => {
    expect(shouldDetectNow(0, Number.NEGATIVE_INFINITY)).toBe(true);
  });
});
