import assert from "node:assert/strict";
import test from "node:test";

import {
  renderBrandCss,
  renderColorAsset,
  renderMetricsSwift,
} from "./design-tokens/generate.mjs";

test("one signal role produces matching web and adaptive Apple colors", () => {
  const roles = {
    signal: { light: "#C9F45B", dark: "#D4F879" },
  };
  const css = renderBrandCss(roles, {}, {});
  const asset = JSON.parse(renderColorAsset(roles.signal));

  assert.match(css, /--brand-signal: #c9f45b;/);
  assert.equal(asset.colors.length, 2);
  assert.deepEqual(asset.colors[1].appearances, [
    { appearance: "luminosity", value: "dark" },
  ]);
  assert.equal(asset.colors[0].color.components.red, 201 / 255);
  assert.equal(asset.colors[1].color.components.green, 248 / 255);
});

test("shared geometry generates native points from CSS pixel values", () => {
  const swift = renderMetricsSwift({
    "radius-control": "8px",
    "radius-panel": "16px",
    "radius-chip": "7px",
    "space-1": "4px",
    "space-2": "8px",
    "space-3": "12px",
    "space-4": "16px",
    "space-5": "20px",
    "space-6": "24px",
  });
  assert.match(swift, /static let radiusPanel: CGFloat = 16/);
  assert.match(swift, /static let space6: CGFloat = 24/);
});
