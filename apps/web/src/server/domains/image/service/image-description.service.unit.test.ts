import { deflateSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { inspectImageFile } from "~/server/domains/image/repo/image-integrity";

import { fetchAnalysisRendition } from "./image-description.service";

const SOURCE_URL = "https://images.example.com/a.png";
const RENDITION_URL =
  "https://images.example.com/cdn-cgi/image/width=2048,format=jpeg/a.png";

const respondWith = (response: Response) => async () => response;

const fetchRendition = (fetcher: typeof fetch, maxBytes = 4 * 1024 * 1024) =>
  fetchAnalysisRendition({
    sourceUrl: SOURCE_URL,
    renditionUrl: RENDITION_URL,
    maxEdge: 2048,
    maxBytes,
    fetcher,
  });

const crc32 = (bytes: Uint8Array) => {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
};

const pngChunk = (type: string, data: Uint8Array, crc?: number) => {
  const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
  const chunk = new DataView(new ArrayBuffer(body.length + 8));
  chunk.setUint32(0, data.length);
  new Uint8Array(chunk.buffer).set(body, 4);
  chunk.setUint32(body.length + 4, crc ?? crc32(body));
  return new Uint8Array(chunk.buffer);
};

/**
 * Synthetic white RGB PNG with intact pixels behind an iTXt chunk whose CRC
 * is wrong: the shape the image edge refused with HTTP 422 / ERROR 9516.
 */
const damagedMetadataPng = (width: number, height: number) => {
  const header = new DataView(new ArrayBuffer(13));
  header.setUint32(0, width);
  header.setUint32(4, height);
  header.setUint8(8, 8);
  header.setUint8(9, 2);
  const rows = new Uint8Array(height * (width * 3 + 1)).fill(255);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk("IHDR", new Uint8Array(header.buffer)),
    ...pngChunk(
      "iTXt",
      new TextEncoder().encode("XML:com.adobe.xmp\0\0\0\0\0<x/>"),
      0xdeadbeef,
    ),
    ...pngChunk("IDAT", deflateSync(rows)),
    ...pngChunk("IEND", new Uint8Array()),
  ]);
};

const EDGE_DECODE_REFUSAL =
  "ERROR 9516: Could not resize the image: error during decoding: Error while decoding the PNG image. The file may be incomplete or damaged";

describe("fetchAnalysisRendition", () => {
  it("rejects oversized advertised renditions before buffering, preserving the original source", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
      { headers: { "content-length": String(4 * 1024 * 1024 + 1) } },
    );
    await expect(fetchRendition(respondWith(response))).rejects.toThrow(
      "exceeds 4194304 bytes",
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds streamed renditions without a content-length header", async () => {
    const response = new Response(new Uint8Array(4 * 1024 * 1024 + 1));
    await expect(fetchRendition(respondWith(response))).rejects.toThrow(
      "exceeds 4194304 bytes",
    );
  });

  it("applies identification's smaller budget before buffering", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
      { headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
    );
    await expect(
      fetchRendition(respondWith(response), 2 * 1024 * 1024),
    ).rejects.toThrow("exceeds 2097152 bytes");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports the raw status and body snippet of a failed rendition", async () => {
    const body = `Error 9401: rendition unavailable ${"x".repeat(2_000)}`;
    const failure = () =>
      fetchRendition(respondWith(new Response(body, { status: 502 })));

    await expect(failure()).rejects.toThrow(
      /HTTP 502.*Error 9401: rendition unavailable/,
    );
    // A snippet, not the whole error page.
    await expect(failure()).rejects.not.toThrow("x".repeat(600));
  });

  it("returns the body bytes of a successful rendition", async () => {
    const bytes = await fetchRendition(
      respondWith(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    );
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("normalizes a PNG the edge cannot decode in-process, bounded on both axes", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url) === RENDITION_URL
        ? new Response(EDGE_DECODE_REFUSAL, { status: 422 })
        : new Response(damagedMetadataPng(1500, 3000)),
    );
    const bytes = await fetchRendition(fetcher as typeof fetch);
    const inspected = await inspectImageFile(bytes, "image/jpeg");
    expect(inspected).toMatchObject({
      detectedContentType: "image/jpeg",
      width: 1024,
      height: 2048,
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      RENDITION_URL,
      SOURCE_URL,
    ]);
  });

  it("keeps the edge refusal for a 422 source it cannot normalize", async () => {
    const fetcher = async (url: string | URL | Request) =>
      String(url) === RENDITION_URL
        ? new Response(EDGE_DECODE_REFUSAL, { status: 422 })
        : new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    await expect(fetchRendition(fetcher as typeof fetch)).rejects.toThrow(
      /HTTP 422.*ERROR 9516/,
    );
  });
});

it("does not adopt model-invented zero nutrients or foreign image attribution", async () => {
  const { normalizeImageDescriptionResult } =
    await import("./image-description.service");
  const result = normalizeImageDescriptionResult(
    {
      description: "A package nutrition panel",
      cutoutEligibility: "ineligible",
      claims: [
        { text: "Nutrition Facts", evidenceKind: "ocr", imageId: "IMG-4K7M" },
      ],
      nutritionFacts: {
        servingGrams: 40,
        nutrients: { kcal: 120 },
        inferredZeroNutrients: ["vitamin_c"],
        inferenceEvidence: "Model guess",
      },
    },
    "IMG-2345",
  );
  expect(result.claims[0]?.imageId).toBe("IMG-2345");
  expect(result.nutritionFacts).toMatchObject({
    nutrients: { kcal: 120 },
    inferredZeroNutrients: [],
    inferenceEvidence: null,
  });
});

it.each([
  { footnote: "Not a significant source of total fat.", named: ["fat"] },
  {
    footnote: "Not a significant source of total fat, calcium, and iron.",
    named: ["fat", "calcium", "iron"],
  },
  {
    footnote: "Not a significant source of total fat and calcium.",
    named: ["fat", "calcium"],
  },
])(
  "retains named inferred zeros from the quoted footnote $footnote",
  async ({ footnote, named }) => {
    const { normalizeImageDescriptionResult } =
      await import("./image-description.service");
    const result = normalizeImageDescriptionResult(
      {
        description: "A package nutrition panel",
        cutoutEligibility: "ineligible",
        claims: [{ text: footnote, evidenceKind: "ocr" }],
        nutritionFacts: {
          servingGrams: 40,
          nutrients: { kcal: 120 },
          inferredZeroNutrients: [...named, "vitamin_c"],
          inferenceEvidence: footnote,
        },
      },
      "IMG-2345",
    );
    expect(result.nutritionFacts).toMatchObject({
      inferredZeroNutrients: named,
      inferenceEvidence: footnote,
    });
  },
);

it("keeps nutrients outside the significant-source footnote unknown", async () => {
  const { normalizeImageDescriptionResult } =
    await import("./image-description.service");
  const evidence =
    "Not a significant source of calcium. Total fat amount unreadable.";
  const result = normalizeImageDescriptionResult(
    {
      description: "A package nutrition panel",
      cutoutEligibility: "ineligible",
      claims: [{ text: evidence, evidenceKind: "ocr" }],
      nutritionFacts: {
        servingGrams: 40,
        nutrients: { kcal: 120 },
        inferredZeroNutrients: ["fat"],
        inferenceEvidence: evidence,
      },
    },
    "IMG-2345",
  );
  expect(result.nutritionFacts).toMatchObject({
    nutrients: { kcal: 120 },
    inferredZeroNutrients: [],
    inferenceEvidence: null,
  });
});
