import { z } from "zod";

import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";

const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export const syntheticBundle = (
  title = "Synthetic bundle",
  overrides: Record<string, z.infer<ReturnType<typeof z.json>>> = {},
) => {
  const hash = sha256(imageBytes);
  const asset = {
    source_path: "OEBPS/shared.png",
    path: `images/${hash}.png`,
    mime: "image/png",
    sha256: hash,
    bytes: imageBytes.length,
  };
  const photo = { path: asset.source_path, mime: asset.mime };
  const cookbook = {
    contract: "cookbook.v1",
    source: {
      label: "synthetic.epub",
      title,
      sha256: sha256(Buffer.from(title)),
      authors: ["Synthetic Author"],
      identifiers: [],
      subjects: [],
    },
    cover: photo,
    chapters: [
      {
        id: "chapter",
        title: "Recipes",
        items: [
          {
            kind: "recipe",
            id: "001.0010",
            title: `${title} carrots`,
            name: `${title} carrots`,
            meta: { description: [], equipment: [] },
            sections: [
              {
                name: null,
                ingredients: [
                  {
                    raw: "1 carrot",
                    line: 11,
                    parsed: {
                      name: "carrot",
                      amounts: [{ value: 1, unit: "each" }],
                    },
                    confidence: "high",
                    ref: null,
                  },
                ],
                steps: [{ text: "Slice the carrot.", line: 12, refs: [] }],
              },
            ],
            photos: [photo],
            notes: [],
            span: { start: 10, end: 13, doc_path: "OEBPS/chapter.xhtml" },
          },
        ],
      },
    ],
    edges: [],
  };
  const report = {
    run_id: "synthetic-run",
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:00:01Z",
    total_cost_usd: 0,
    cost_complete: true,
    wall_ms: 1000,
    incomplete: true,
    cancelled: false,
    calls: [],
    chunks: [],
    crosscheck: {
      nav_titles: 1,
      matched: 1,
      missing: [],
      phantom: [],
      recall: 1,
    },
    usage_by_model: [],
  };
  const manifest = {
    format: "cookbook-bundle",
    version: 1,
    extraction: "extraction.json",
    preview: "index.html",
    source_sha256: cookbook.source.sha256,
    run_id: report.run_id,
    incomplete: true,
    images: [asset],
    ...overrides,
  };
  return { manifest, cookbook, report, asset, imageBytes };
};

/** Tiny authored ZIP writer; also permits malformed archive metadata for guard tests. */
export function syntheticZip(
  entries: Array<{
    path: string;
    bytes: Uint8Array;
    deflate?: boolean;
    declaredSize?: number;
  }>,
) {
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const body = entry.deflate
      ? deflateRawSync(entry.bytes)
      : Buffer.from(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(entry.bytes), 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.declaredSize ?? entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 28);
    central.writeUInt32LE(offset, 42);
    local.push(header, name, body);
    directory.push(central, name);
    offset += header.length + name.length + body.length;
  }
  const central = Buffer.concat(directory);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(central.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, footer]);
}

export function syntheticCookbookArchive(
  title?: string,
  overrides?: Record<string, z.infer<ReturnType<typeof z.json>>>,
  deflate = false,
) {
  const fixture = syntheticBundle(title, overrides);
  return {
    ...fixture,
    bytes: syntheticZip([
      {
        path: "manifest.json",
        bytes: Buffer.from(JSON.stringify(fixture.manifest)),
        deflate,
      },
      {
        path: "extraction.json",
        bytes: Buffer.from(
          JSON.stringify({
            cookbook: fixture.cookbook,
            report: fixture.report,
          }),
        ),
        deflate,
      },
      {
        path: "index.html",
        bytes: Buffer.from("<p>Synthetic offline preview</p>"),
      },
      { path: fixture.asset.path, bytes: fixture.imageBytes, deflate },
    ]),
  };
}
