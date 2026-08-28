import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { edgeForDrop } from "./use-board-dnd";

function event(translatedTop: number, targetTop = 100) {
  return fromPartial<Parameters<typeof edgeForDrop>[0]>({
    active: {
      rect: {
        current: {
          translated: {
            top: translatedTop,
            left: 0,
            width: 120,
            height: 40,
            right: 120,
            bottom: translatedTop + 40,
          },
        },
      },
    },
    over: {
      rect: {
        top: targetTop,
        left: 0,
        width: 120,
        height: 40,
        right: 120,
        bottom: targetTop + 40,
      },
    },
  });
}

describe("edgeForDrop", () => {
  it("places a translated card above the target when its centre is in the top half", () => {
    expect(edgeForDrop(event(70))).toBe("top");
  });

  it("places a translated card below the target when its centre is in the bottom half", () => {
    expect(edgeForDrop(event(110))).toBe("bottom");
  });
});
