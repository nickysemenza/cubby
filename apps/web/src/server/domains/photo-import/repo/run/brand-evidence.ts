import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  PhotoGroupProposal,
  PhotoRunImage,
} from "@cubby/schemas/photo-import-run";
import { and, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";

const identityWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Only literal retained OCR/label claims support a Brand choice; catalog identity is not evidence. */
export async function photoBrandEvidence(
  db: Database,
  images: readonly PhotoRunImage[],
): Promise<NonNullable<PhotoGroupProposal["brandEvidence"]>> {
  const sources = images.flatMap((image) => [
    ...(image.recognizedText
      ? [{ id: image.id, text: image.recognizedText }]
      : []),
    ...(image.descriptionEvidence?.claims ?? [])
      .filter((claim) => claim.evidenceKind !== "visual")
      .map((claim) => ({ id: image.id, text: claim.text })),
  ]);
  if (!sources.length) return [];
  const literal = ` ${identityWords(sources.map((source) => source.text).join(" "))} `;
  // Filter the live roster in SQL; a photo read never loads every Vendor.
  const matches = await getDb(db)
    .select({
      id: vendor.shortcode,
      name: vendor.name,
      aliases: vendor.aliases,
    })
    .from(vendor)
    .where(
      and(
        notDeleted(vendor),
        sql`EXISTS (
      SELECT 1 FROM unnest(ARRAY[${vendor.name}] || ${vendor.aliases}) AS label(value)
      WHERE trim(label.value) <> '' AND position(
        ' ' || trim(regexp_replace(lower(label.value), '[^[:alnum:]]+', ' ', 'g')) || ' '
        IN ${literal}
      ) > 0
    )`,
      ),
    );
  const evidence = new Map<
    string,
    NonNullable<PhotoGroupProposal["brandEvidence"]>[number]
  >();
  for (const source of sources) {
    const words = ` ${identityWords(source.text)} `;
    for (const match of matches) {
      if (
        ![match.name, ...match.aliases].some((name) =>
          words.includes(` ${identityWords(name)} `),
        )
      )
        continue;
      const key = identityWords(match.name);
      const entry = evidence.get(key) ?? {
        name: match.name,
        imageIds: [],
        matches: [],
      };
      if (!entry.imageIds.includes(source.id)) entry.imageIds.push(source.id);
      if (!entry.matches.some((candidate) => candidate.id === match.id))
        entry.matches.push({
          id: parseShortcodeFor("vendor", match.id),
          name: match.name,
        });
      evidence.set(key, entry);
    }
    // A new roster entry needs an explicit brand claim, never an arbitrary OCR word.
    for (const line of source.text.split("\n")) {
      const name = /^brand(?: name)?\s*[:=]\s*(.{1,500})$/i
        .exec(line.trim())?.[1]
        ?.trim();
      if (!name) continue;
      const key = identityWords(name);
      const entry = evidence.get(key) ?? { name, imageIds: [], matches: [] };
      if (!entry.imageIds.includes(source.id)) entry.imageIds.push(source.id);
      evidence.set(key, entry);
    }
  }
  return [...evidence.values()];
}
