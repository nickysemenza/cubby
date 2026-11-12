import { describe, expect, it } from "vitest";

import { uploadChunks } from "./upload-chunks";

describe("embedding upload chunks", () => {
  it("fills the UTF-8 byte budget exactly before starting another request", () => {
    // 36 full inputs leave 5,088 bytes in the 300 KB request.
    const inputs = [
      ...Array.from({ length: 36 }, () => ({ text: "é".repeat(4_096) })),
      { text: "é".repeat(2_544) },
      { text: "x" },
    ];
    const chunks = uploadChunks(inputs);
    expect(chunks.map((chunk) => chunk.length)).toEqual([37, 1]);
    expect(chunks.flat()).toEqual(inputs);
  });

  it("starts another request after 2,048 short inputs", () => {
    const inputs = Array.from({ length: 2_049 }, () => ({ text: "x" }));
    const chunks = uploadChunks(inputs);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2_048, 1]);
    expect(chunks.flat()).toEqual(inputs);
  });

  it("isolates an input above 8,192 UTF-8 bytes without losing its neighbors", () => {
    const inputs = [
      { text: "é".repeat(4_096) },
      { text: "neighbor" },
      { text: "é".repeat(4_096) + "x" },
      { text: "tail" },
    ];
    expect(uploadChunks(inputs)).toEqual([
      inputs.slice(0, 2),
      [inputs[2]],
      [inputs[3]],
    ]);
    expect(uploadChunks([])).toEqual([]);
  });
});
