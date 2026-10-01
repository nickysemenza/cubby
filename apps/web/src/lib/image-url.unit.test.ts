import imageVectors from "@cubby/shared/golden-vectors/image-url.json";
import { describe, expect, it } from "vitest";

import { IMAGE_WIDTHS, transformWidth, transformedImageUrl } from "./image-url";

const BUCKET_SRC = `${__R2_PUBLIC_URL__}/cubby/images/a.jpg`;

describe("transformWidth", () => {
  it.each([
    [16, 128],
    [64, 128],
    [65, 640],
    [256, 640],
    [320, 640],
    [321, 2048],
    [800, 2048],
    [1600, 2048],
    [5000, 2048],
  ])("snaps a %ipx rendered width to the %i rung", (rendered, rung) => {
    expect(transformWidth(rendered)).toBe(rung);
  });

  it("only ever produces a rung", () => {
    for (let width = 1; width <= 3000; width += 7) {
      expect(IMAGE_WIDTHS).toContain(transformWidth(width));
    }
  });
});

describe("transformedImageUrl", () => {
  it("rewrites a bucket URL to the snapped cdn-cgi variant", () => {
    expect(transformedImageUrl(BUCKET_SRC, 40)).toBe(
      `${__R2_PUBLIC_URL__}/cdn-cgi/image/width=128,quality=80,format=auto,fit=scale-down/cubby/images/a.jpg`,
    );
  });

  it("leaves non-bucket URLs untouched", () => {
    expect(transformedImageUrl("https://example.com/a.jpg", 40)).toBe(
      "https://example.com/a.jpg",
    );
  });

  it("leaves already-transformed URLs untouched", () => {
    const once = transformedImageUrl(BUCKET_SRC, 40);
    expect(transformedImageUrl(once, 800)).toBe(once);
  });

  it("passes through strings that are not URLs", () => {
    expect(transformedImageUrl("not a url", 40)).toBe("not a url");
  });
});

// Shared with apps/apple ImageTransformTests: the native app mints the same
// URLs so the edge cache is shared across clients, so the two must not drift.
describe("golden vectors", () => {
  const expand = (value: string) =>
    value.replaceAll("{bucket}", __R2_PUBLIC_URL__);

  it("shares the rung ladder", () => {
    expect([...IMAGE_WIDTHS]).toEqual(imageVectors.rungs);
  });

  it.each(imageVectors.widths)("snaps $rendered to $rung", (vector) => {
    expect(transformWidth(vector.rendered)).toBe(vector.rung);
  });

  it.each(imageVectors.rewrites)("rewrites $in", (vector) => {
    const input = expand(vector.in);
    expect(transformedImageUrl(input, vector.width)).toBe(
      vector.out === null ? input : expand(vector.out),
    );
  });
});
