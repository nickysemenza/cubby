import { describe, expect, it } from "vitest";

import {
  classifyImageProvenanceFromFilename,
  seedCapturedAtFromAnalysis,
  type FilenameProvenanceInput,
} from "./image-provenance-heuristics";

const input = (
  overrides: Partial<FilenameProvenanceInput>,
): FilenameProvenanceInput => ({
  filename: null,
  sourceAssetUrl: null,
  width: null,
  height: null,
  ...overrides,
});

describe("classifyImageProvenanceFromFilename", () => {
  const cases: Array<{
    name: string;
    given: FilenameProvenanceInput;
    expectSource: "own" | "catalog" | "screenshot" | null;
    expectRuleId?: string;
  }> = [
    {
      name: "legacy uploader photo.jpeg at 2048px wide",
      given: input({ filename: "photo.jpeg", width: 2048, height: 1536 }),
      expectSource: "own",
      expectRuleId: "legacy-uploader-photo-jpeg",
    },
    {
      name: "legacy uploader photo.jpeg at 2048px tall",
      given: input({ filename: "photo.jpeg", width: 1536, height: 2048 }),
      expectSource: "own",
      expectRuleId: "legacy-uploader-photo-jpeg",
    },
    {
      name: "photo.jpeg at an unrelated size is not the legacy uploader",
      given: input({ filename: "photo.jpeg", width: 800, height: 600 }),
      expectSource: null,
    },
    {
      name: "IMG_#### is an iOS camera filename",
      given: input({ filename: "IMG_1234.HEIC" }),
      expectSource: "own",
      expectRuleId: "camera-filename-ios",
    },
    {
      name: "DSC-prefixed filename is a DSLR",
      given: input({ filename: "DSC_5678.JPG" }),
      expectSource: "own",
      expectRuleId: "camera-filename-dslr",
    },
    {
      name: "PXL_-prefixed filename is a Pixel phone",
      given: input({ filename: "PXL_20240101_120000.jpg" }),
      expectSource: "own",
      expectRuleId: "camera-filename-pixel",
    },
    {
      name: "a present sourceAssetUrl is catalog evidence",
      given: input({
        filename: "cover.jpg",
        sourceAssetUrl: "https://vendor.example.com/img/cover.jpg",
      }),
      expectSource: "catalog",
      expectRuleId: "catalog-source-asset-url",
    },
    {
      name: "a dimension suffix (-800x800) is a catalog filename",
      given: input({ filename: "widget-800x800.jpg" }),
      expectSource: "catalog",
      expectRuleId: "catalog-dimension-suffix",
    },
    {
      name: "an Amazon _SL1500_ marker is a catalog filename",
      given: input({ filename: "71abcXYZ._SL1500_.jpg" }),
      expectSource: "catalog",
      expectRuleId: "catalog-amazon-sl-marker",
    },
    {
      name: "a trailing WxH.ext is a catalog filename",
      given: input({ filename: "product-image.500x500.webp" }),
      expectSource: "catalog",
      expectRuleId: "catalog-dimension-extension",
    },
    {
      name: "a 'Screenshot ' prefix is a screenshot",
      given: input({ filename: "Screenshot 2024-01-01 at 12.00.00.png" }),
      expectSource: "screenshot",
      expectRuleId: "screenshot-filename-prefix",
    },
    {
      name: "an iPhone screen resolution is a screenshot even with no filename hint",
      given: input({
        filename: "9F2A1C3D-1234.PNG",
        width: 1170,
        height: 2532,
      }),
      expectSource: "screenshot",
      expectRuleId: "screenshot-common-dimensions",
    },
    {
      name: "a rotated common screen resolution still matches",
      given: input({ filename: "x.png", width: 2532, height: 1170 }),
      expectSource: "screenshot",
      expectRuleId: "screenshot-common-dimensions",
    },
    {
      name: "an ordinary photo filename with no dimensions matches nothing",
      given: input({ filename: "vacation.jpg" }),
      expectSource: null,
    },
    {
      name: "a null filename with no other evidence matches nothing",
      given: input({}),
      expectSource: null,
    },
  ];

  it.each(cases)("$name", ({ given, expectSource, expectRuleId }) => {
    const result = classifyImageProvenanceFromFilename(given);
    const expected =
      expectSource === null
        ? null
        : {
            source: expectSource,
            provenanceEvidence: { basis: "filename", ruleId: expectRuleId },
          };
    expect(result).toEqual(expected);
  });

  it("evaluates screenshot rules before catalog rules on the same row", () => {
    // A filename that could plausibly look catalog-ish but is also a clear
    // screenshot: the screenshot prefix wins.
    const result = classifyImageProvenanceFromFilename(
      input({ filename: "Screenshot 800x600 test.png" }),
    );
    expect(result?.source).toBe("screenshot");
    expect(result?.provenanceEvidence.ruleId).toBe(
      "screenshot-filename-prefix",
    );
  });
});

describe("seedCapturedAtFromAnalysis", () => {
  const ANALYZED = new Date("2024-03-01T12:00:00Z");

  it("seeds capturedAt when the image has none and analysis has one", () => {
    expect(seedCapturedAtFromAnalysis(null, ANALYZED)).toEqual({
      capturedAt: ANALYZED,
      provenanceEvidence: { basis: "analysis" },
    });
  });

  it("does not override an existing capturedAt", () => {
    const existing = new Date("2020-01-01T00:00:00Z");
    expect(seedCapturedAtFromAnalysis(existing, ANALYZED)).toBeNull();
  });

  it("returns null when analysis has no capturedAt either", () => {
    expect(seedCapturedAtFromAnalysis(null, null)).toBeNull();
  });
});
