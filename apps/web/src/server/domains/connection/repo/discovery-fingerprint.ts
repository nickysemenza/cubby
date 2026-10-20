import type { EntityRef } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { Database } from "~/server/db";
import { readInputRevisions } from "~/server/generic/derived-refresh/repo/revisions";
import { resolveLiveShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { connectionInputKeys } from "./discovery-inputs";

const sourceKind = z.enum(shortcodeEntities);

/** Fixed-size input vectors only: no candidates, context reads or corpus scans. */
export async function connectionDiscoveryFingerprints(
  db: Database,
  sources: readonly EntityRef[],
): Promise<string[]> {
  const groups = new Map<z.infer<typeof sourceKind>, string[]>();
  for (const source of sources) {
    const kind = sourceKind.parse(source.entityKind);
    const group = groups.get(kind) ?? [];
    group.push(source.entityId);
    groups.set(kind, group);
  }
  const ids = new Map<string, string>();
  for (const [kind, codes] of groups) {
    for (const [code, id] of await resolveLiveShortcodes(db, codes, kind))
      ids.set(`${kind}:${code}`, id);
  }
  const keys = (source: EntityRef) => {
    const id = ids.get(`${source.entityKind}:${source.entityId}`);
    if (!id)
      throw new Error(`Connection ${source.entityKind} no longer exists`);
    const inputs = connectionInputKeys(source.entityKind);
    return [
      `entity:${source.entityKind}:${id}`,
      ...inputs,
      ...inputs
        .filter((key) => key.startsWith("kind:"))
        .flatMap((key) => [
          key.replace("kind:", "projection:"),
          key.replace("kind:", "embedding:"),
        ]),
    ];
  };
  const sourceKeys = sources.map(keys);
  const revisions = new Map(await readInputRevisions(db, sourceKeys.flat()));
  return Promise.all(
    sources.map((source, index) =>
      sha256Hex(
        JSON.stringify([
          "connection-input-revisions-v3",
          source.entityKind,
          source.entityId,
          [...new Set(sourceKeys[index])]
            .sort()
            .map((key) => [key, revisions.get(key) ?? 0]),
        ]),
      ),
    ),
  );
}

export async function connectionDiscoveryFingerprint(
  db: Database,
  source: EntityRef,
) {
  const [fingerprint] = await connectionDiscoveryFingerprints(db, [source]);
  if (!fingerprint) throw new Error("Missing connection input fingerprint");
  return fingerprint;
}
