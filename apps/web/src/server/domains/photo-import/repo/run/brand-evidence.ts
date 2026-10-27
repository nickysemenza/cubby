import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  PhotoGroupProposal,
  PhotoRunImage,
} from "@cubby/schemas/photo-import-run";
import { brandNameKey } from "@cubby/schemas/vendor";
import { and, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { vendor } from "~/server/db/schema";

/** Only literal retained OCR/label claims support a Brand choice; catalog identity is not evidence. */
export async function photoBrandEvidence(
  db: Database,
  images: readonly PhotoRunImage[],
  labelImageIds: ReadonlySet<string> = new Set(),
): Promise<NonNullable<PhotoGroupProposal["brandEvidence"]>> {
  const sources = images.flatMap((image) => [
    ...(image.recognizedText
      ? [{ id: image.id, text: image.recognizedText, kind: "ocr" as const }]
      : []),
    ...(image.descriptionEvidence?.claims ?? [])
      .filter((claim) => claim.evidenceKind !== "visual")
      .map((claim) => ({
        id: image.id,
        text: claim.text,
        kind: claim.evidenceKind,
      })),
  ]);
  if (!sources.length) return [];
  const literal = ` ${brandNameKey(sources.map((source) => source.text).join(" "))} `;
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
    const words = ` ${brandNameKey(source.text)} `;
    const lines = source.text.split("\n").map((line) => line.trim());
    const explicitNames = lines.flatMap((line) => {
      const name = /^brand(?: name)?\s*[:=]\s*(.{1,500})$/i
        .exec(line)?.[1]
        ?.trim();
      return name ? [name] : [];
    });
    for (const match of matches) {
      if (
        ![match.name, ...match.aliases].some((name) =>
          words.includes(` ${brandNameKey(name)} `),
        )
      )
        continue;
      const key = brandNameKey(match.name);
      const entry = evidence.get(key) ?? {
        name: match.name,
        imageIds: [],
        prefillImageIds: [],
        matches: [],
      };
      if (!entry.imageIds.includes(source.id)) entry.imageIds.push(source.id);
      const names = [match.name, ...match.aliases];
      const explicit = explicitNames.some((name) =>
        names.some(
          (candidate) => brandNameKey(name) === brandNameKey(candidate),
        ),
      );
      const printedLabel =
        (source.kind === "label" || labelImageIds.has(source.id)) &&
        lines.some((line) =>
          names.some(
            (name) =>
              brandNameKey(name).length >= 4 &&
              brandNameKey(line) === brandNameKey(name),
          ),
        );
      if (explicit || printedLabel) {
        entry.prefillImageIds ??= [];
        if (!entry.prefillImageIds.includes(source.id))
          entry.prefillImageIds.push(source.id);
      }
      if (!entry.matches.some((candidate) => candidate.id === match.id))
        entry.matches.push({
          id: parseShortcodeFor("vendor", match.id),
          name: match.name,
        });
      evidence.set(key, entry);
    }
    // A new roster entry needs an explicit brand claim, never an arbitrary OCR word.
    for (const name of explicitNames) {
      if (
        matches.some((match) =>
          [match.name, ...match.aliases].some(
            (candidate) => brandNameKey(candidate) === brandNameKey(name),
          ),
        )
      )
        continue;
      const key = brandNameKey(name);
      const entry = evidence.get(key) ?? {
        name,
        imageIds: [],
        prefillImageIds: [],
        matches: [],
      };
      if (!entry.imageIds.includes(source.id)) entry.imageIds.push(source.id);
      evidence.set(key, entry);
    }
  }
  return [...evidence.values()];
}
