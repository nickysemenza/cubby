import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  isEmbeddableEntity,
  searchableEntitySchema,
  type SearchableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { entityEmbedding } from "~/server/db/retained-tables";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  EMBEDDING_CLEANUP_DRAIN,
  EMBEDDING_CLEANUP_TARGET,
} from "~/server/generic/embedding/repo/embedding-cleanup";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import type { SemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  dropWork,
  lockWork,
  markWork,
  type WorkItem,
} from "~/server/generic/jobs/repo/work-items";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";
import {
  SHORTCODE_TABLE,
  orderedEntityLockKinds,
} from "~/server/generic/shortcode/repo/shortcode-tables";

/** One refresh drain Job; items are keyed by source entity id. */
export const EMBEDDING_REFRESH_DRAIN = {
  key: "embedding:refresh",
  kind: "embedding.refresh",
} as const;
export const EMBEDDING_REFRESH_TARGET = "embedding.refresh";

type Artifact = {
  id: string;
  entityKind: SearchableEntity;
  entityId: string;
  embeddingText: string;
  embeddingHash: string;
  artifactHash: string | null;
  provider: string;
  model: string;
  dimensions: number;
  artifactState: string;
  vectorHash: string | null;
  submissionId: string | null;
  observedAt: Date | null;
};

export type EmbeddingDrainEntry = {
  item: WorkItem;
  ref: SearchableEntityRef | null;
  text: string;
  hash: string;
  config: SemanticEmbeddingConfig;
  artifactId?: string;
  vectorHash?: string;
  submissionId?: string;
  status: "selected" | "upload" | "ready" | "poll" | "missing" | "obsolete";
  pollUntil?: Date;
};

export type EmbeddingDrainPage = {
  byItem: Map<WorkItem, EmbeddingDrainEntry>;
  artifacts: readonly Artifact[];
  uploads: EmbeddingDrainEntry[];
  submitted: EmbeddingDrainEntry[];
  stalePending: Artifact[];
};

export type EmbeddingUploadReceipt = {
  entry: EmbeddingDrainEntry;
  submissionId: string;
  vectorHash: string;
};

const matchesConfig = (artifact: Artifact, config: SemanticEmbeddingConfig) =>
  artifact.provider === config.provider &&
  artifact.model === config.model &&
  artifact.dimensions === config.dimensions;

async function findArtifactRows(
  db: Database,
  refs: readonly SearchableEntityRef[],
) {
  if (!refs.length) return [];
  return getDb(db)
    .select({
      id: entityEmbedding.id,
      entityKind: entityEmbedding.entityKind,
      entityId: entityEmbedding.entityId,
      embeddingText: entityEmbedding.embeddingText,
      embeddingHash: entityEmbedding.embeddingHash,
      artifactHash: entityEmbedding.artifactHash,
      provider: entityEmbedding.provider,
      model: entityEmbedding.model,
      dimensions: entityEmbedding.dimensions,
      artifactState: entityEmbedding.artifactState,
      vectorHash: entityEmbedding.vectorHash,
      submissionId: entityEmbedding.submissionId,
      observedAt: entityEmbedding.observedAt,
    })
    .from(entityEmbedding)
    .where(
      and(
        inArray(
          entityEmbedding.entityId,
          refs.map((ref) => ref.entityId),
        ),
        isNull(entityEmbedding.deletedAt),
        inArray(entityEmbedding.artifactState, [
          embeddingArtifactState.enum.prepared,
          embeddingArtifactState.enum.submitting,
          embeddingArtifactState.enum.submitted,
          embeddingArtifactState.enum.selected,
        ]),
      ),
    )
    .orderBy(
      entityEmbedding.entityKind,
      entityEmbedding.entityId,
      entityEmbedding.id,
    );
}

function findCurrentSelection(
  artifacts: readonly Artifact[],
  hash: string,
  config: SemanticEmbeddingConfig,
) {
  return artifacts.find(
    (artifact) =>
      artifact.artifactState === embeddingArtifactState.enum.selected &&
      matchesConfig(artifact, config) &&
      artifact.artifactHash === hash,
  );
}

function findPendingArtifact(
  artifacts: readonly Artifact[],
  hash: string,
  config: SemanticEmbeddingConfig,
) {
  return artifacts.find(
    (artifact) =>
      artifact.artifactState !== embeddingArtifactState.enum.selected &&
      matchesConfig(artifact, config) &&
      artifact.artifactHash === hash,
  );
}

export async function prepareEmbeddingDrainPage(
  db: Database,
  items: readonly WorkItem[],
  config: SemanticEmbeddingConfig,
): Promise<EmbeddingDrainPage> {
  const byItem = new Map<WorkItem, EmbeddingDrainEntry>();
  const identityRows = items.length
    ? await getDb(db)
        .select({ id: entityIdentity.id, kind: entityIdentity.kind })
        .from(entityIdentity)
        .where(
          inArray(
            entityIdentity.id,
            items.map((item) => item.ref),
          ),
        )
    : [];
  const kindById = new Map(
    identityRows.map((row) => [
      row.id,
      searchableEntitySchema.safeParse(row.kind),
    ]),
  );
  const refs: SearchableEntityRef[] = [];
  for (const item of items) {
    const parsed = kindById.get(item.ref);
    if (!parsed?.success || !isEmbeddableEntity(parsed.data)) {
      byItem.set(item, {
        item,
        ref: null,
        text: "",
        hash: "",
        config,
        status: "missing",
      });
      continue;
    }
    refs.push({ entityKind: parsed.data, entityId: item.ref });
  }
  const documents = await prepareSearchDocuments(db, refs);
  const documentByRef = new Map(
    documents.entries.map(({ source, body }) => [
      entityRefKey(source.entityKind, source.entityId),
      { source, body },
    ]),
  );
  const missing = new Set(
    documents.missing.map((ref) => entityRefKey(ref.entityKind, ref.entityId)),
  );
  const artifacts = await findArtifactRows(db, refs);
  const uploads: EmbeddingDrainEntry[] = [];
  const submitted: EmbeddingDrainEntry[] = [];
  const stalePending: Artifact[] = [];

  for (const item of items) {
    if (byItem.has(item)) continue;
    const ref = refs.find((candidate) => candidate.entityId === item.ref);
    if (!ref) continue;
    const key = entityRefKey(ref.entityKind, ref.entityId);
    const document = documentByRef.get(key);
    if (!document || missing.has(key)) {
      byItem.set(item, {
        item,
        ref,
        text: "",
        hash: "",
        config,
        status: "missing",
      });
      continue;
    }
    const text = normalizeSearchText(document.body);
    const hash = await embeddingTextHash({
      entityKind: ref.entityKind,
      ...config,
      text,
    });
    const entityArtifacts = artifacts.filter(
      (artifact) => artifact.entityId === item.ref,
    );
    const pending = findPendingArtifact(entityArtifacts, hash, config);
    stalePending.push(
      ...entityArtifacts.filter(
        (artifact) =>
          artifact.artifactState !== embeddingArtifactState.enum.selected &&
          artifact !== pending,
      ),
    );
    const selected = findCurrentSelection(entityArtifacts, hash, config);
    if (selected) {
      byItem.set(item, {
        item,
        ref,
        text,
        hash,
        config,
        artifactId: selected.id,
        vectorHash: selected.vectorHash ?? undefined,
        submissionId: selected.submissionId ?? undefined,
        status: "selected",
      });
      continue;
    }
    const entry: EmbeddingDrainEntry = {
      item,
      ref,
      text,
      hash,
      config,
      artifactId: pending?.id,
      vectorHash: pending?.vectorHash ?? undefined,
      submissionId: pending?.submissionId ?? undefined,
      status:
        pending?.artifactState === embeddingArtifactState.enum.submitted
          ? "poll"
          : "upload",
    };
    byItem.set(item, entry);
    if (entry.status === "poll") submitted.push(entry);
    else uploads.push(entry);
  }
  return { byItem, artifacts, uploads, submitted, stalePending };
}

export async function stageEmbeddingDrainArtifacts(
  tx: Database,
  items: readonly WorkItem[],
  page: EmbeddingDrainPage,
) {
  const held = await lockWork(tx, items);
  const currentRefs = new Set(held.map((item) => item.ref));
  const stale = page.stalePending.filter((artifact) =>
    currentRefs.has(artifact.entityId),
  );
  if (stale.length) {
    const now = new Date();
    await getDb(tx)
      .update(entityEmbedding)
      .set({ artifactState: "failed", deletedAt: now })
      .where(
        and(
          inArray(
            entityEmbedding.id,
            stale.map((artifact) => artifact.id),
          ),
          isNull(entityEmbedding.deletedAt),
        ),
      );
    await markWork(
      tx,
      EMBEDDING_CLEANUP_DRAIN,
      stale.map((artifact) => ({
        target: EMBEDDING_CLEANUP_TARGET,
        ref: artifact.id,
      })),
    );
  }
  const create = page.uploads.filter(
    (entry) => !entry.artifactId && currentRefs.has(entry.item.ref),
  );
  const created = create.length
    ? await getDb(tx)
        .insert(entityEmbedding)
        .values(
          create.map((entry) => ({
            entityKind: entry.ref!.entityKind,
            entityId: entry.ref!.entityId,
            embeddingText: entry.text,
            embeddingHash: entry.hash,
            artifactHash: entry.hash,
            ...entry.config,
            artifactState: "prepared" as const,
          })),
        )
        .returning({
          id: entityEmbedding.id,
          entityId: entityEmbedding.entityId,
        })
    : [];
  const ids = new Map(created.map((row) => [row.entityId, row.id]));
  for (const entry of page.uploads) {
    if (!currentRefs.has(entry.item.ref)) entry.status = "obsolete";
    else entry.artifactId ??= ids.get(entry.item.ref);
  }
  for (const item of items) {
    if (!currentRefs.has(item.ref)) {
      const entry = page.byItem.get(item);
      if (entry) entry.status = "obsolete";
    }
  }
}

export async function markEmbeddingArtifactsSubmitting(
  tx: Database,
  entries: readonly EmbeddingDrainEntry[],
) {
  const held = await lockWork(
    tx,
    entries.map((entry) => entry.item),
  );
  const ids = entries
    .filter((entry) => held.includes(entry.item))
    .map((entry) => entry.artifactId!);
  if (ids.length)
    await getDb(tx)
      .update(entityEmbedding)
      .set({ artifactState: "submitting" })
      .where(inArray(entityEmbedding.id, ids));
  return held;
}

export async function recordEmbeddingUploadReceipts(
  tx: Database,
  receipts: readonly EmbeddingUploadReceipt[],
) {
  const held = new Set(
    await lockWork(
      tx,
      receipts.map(({ entry }) => entry.item),
    ),
  );
  const current = receipts.filter(({ entry }) => held.has(entry.item));
  const superseded = receipts.filter(({ entry }) => !held.has(entry.item));
  const receivedAt = new Date();
  for (const { entry, submissionId, vectorHash } of current) {
    await getDb(tx)
      .update(entityEmbedding)
      .set({
        artifactState: "submitted",
        artifactHash: entry.hash,
        vectorHash,
        submissionId,
        observedAt: receivedAt,
      })
      .where(eq(entityEmbedding.id, entry.artifactId!));
    entry.vectorHash = vectorHash;
    entry.submissionId = submissionId;
    entry.status = "poll";
    entry.pollUntil = new Date(Date.now() + 5_000);
  }
  if (superseded.length) {
    for (const { entry, submissionId, vectorHash } of superseded)
      await getDb(tx)
        .update(entityEmbedding)
        .set({
          artifactState: "failed",
          artifactHash: entry.hash,
          vectorHash,
          submissionId,
          observedAt: receivedAt,
          deletedAt: receivedAt,
        })
        .where(eq(entityEmbedding.id, entry.artifactId!));
    await markWork(
      tx,
      EMBEDDING_CLEANUP_DRAIN,
      superseded.map(({ entry }) => ({
        target: EMBEDDING_CLEANUP_TARGET,
        ref: entry.artifactId!,
      })),
    );
  }
}

async function lockPublicationSources(
  tx: Database,
  entries: readonly EmbeddingDrainEntry[],
) {
  const refs = entries.flatMap((entry) => (entry.ref ? [entry.ref] : []));
  if (!refs.length) return new Set<string>();
  const kinds = orderedEntityLockKinds(refs.map((ref) => ref.entityKind));
  const locks = kinds.map((kind, index) => {
    const source = SHORTCODE_TABLE[kind];
    const previous = index
      ? sql`AND (SELECT count(*) FROM ${sql.identifier(`sources_${index - 1}`)}) >= 0`
      : sql``;
    return sql`${sql.identifier(`sources_${index}`)} AS MATERIALIZED (
      SELECT ${source.id} AS id, ${kind}::text AS kind FROM ${source}
      WHERE ${inArray(
        source.id,
        refs
          .filter((ref) => ref.entityKind === kind)
          .map((ref) => ref.entityId),
      )}
        AND ${isNull(source.deletedAt)} ${previous}
      ORDER BY ${source.id} FOR SHARE)`;
  });
  const live = await getDb(tx).execute<{
    id: string;
    kind: SearchableEntity;
  }>(sql`
    WITH ${sql.join(locks, sql`, `)}, sources AS MATERIALIZED (
      ${sql.join(
        kinds.map(
          (_, index) =>
            sql`SELECT * FROM ${sql.identifier(`sources_${index}`)}`,
        ),
        sql` UNION ALL `,
      )}
    ), identities AS MATERIALIZED (
      SELECT ${entityIdentity.id} AS id FROM ${entityIdentity}
      WHERE ${entityIdentity.id} IN (SELECT id FROM sources)
        AND ${isNull(entityIdentity.deletedAt)}
      ORDER BY ${entityIdentity.id} FOR SHARE
    ) SELECT sources.* FROM sources JOIN identities USING (id)`);
  return new Set(live.rows.map(({ id, kind }) => entityRefKey(kind, id)));
}

export async function publishEmbeddingDrainSelections(
  tx: Database,
  items: readonly WorkItem[],
  page: EmbeddingDrainPage,
) {
  const entries = items.flatMap((item) => {
    const entry = page.byItem.get(item);
    return entry?.status === "ready" && entry.ref ? [entry] : [];
  });
  if (!entries.length) return;
  const live = await lockPublicationSources(tx, entries);
  const lockLiveEntries = entries.filter((entry) =>
    live.has(entityRefKey(entry.ref!.entityKind, entry.ref!.entityId)),
  );
  const docs = await prepareSearchDocuments(
    tx,
    lockLiveEntries.map((entry) => entry.ref!),
  );
  const bodies = new Map(
    docs.entries.map(({ source, body }) => [
      entityRefKey(source.entityKind, source.entityId),
      body,
    ]),
  );
  const missing = new Set(
    docs.missing.map(({ entityKind, entityId }) =>
      entityRefKey(entityKind, entityId),
    ),
  );
  const selected: EmbeddingDrainEntry[] = [];
  for (const entry of entries) {
    const ref = entry.ref!;
    const key = entityRefKey(ref.entityKind, ref.entityId);
    if (!live.has(key) || missing.has(key)) {
      await dropWork(tx, EMBEDDING_REFRESH_TARGET, [entry.item.ref]);
      continue;
    }
    const body = bodies.get(key);
    const currentHash =
      body === undefined
        ? null
        : await embeddingTextHash({
            entityKind: ref.entityKind,
            ...entry.config,
            text: normalizeSearchText(body),
          });
    if (currentHash !== entry.hash) {
      await markWork(tx, EMBEDDING_REFRESH_DRAIN, [
        { target: EMBEDDING_REFRESH_TARGET, ref: entry.item.ref },
      ]);
      continue;
    }
    selected.push(entry);
  }
  if (!selected.length) return;
  const now = new Date();
  await getDb(tx)
    .update(entityEmbedding)
    .set({ artifactState: "retired", deletedAt: now })
    .where(
      and(
        isNull(entityEmbedding.deletedAt),
        or(
          ...selected.map(({ ref }) =>
            and(
              eq(entityEmbedding.entityKind, ref!.entityKind),
              eq(entityEmbedding.entityId, ref!.entityId),
            ),
          ),
        ),
      ),
    );
  await getDb(tx)
    .insert(entityEmbedding)
    .values(
      selected.map((entry) => ({
        id: entry.artifactId!,
        entityKind: entry.ref!.entityKind,
        entityId: entry.ref!.entityId,
        embeddingText: entry.text,
        embeddingHash: entry.hash,
        artifactHash: entry.hash,
        ...entry.config,
        artifactState: "selected" as const,
        vectorHash: entry.vectorHash!,
        submissionId: entry.submissionId!,
        observedAt: now,
        indexedAt: now,
        deletedAt: null,
      })),
    )
    .onConflictDoUpdate({
      target: entityEmbedding.id,
      set: {
        artifactState: "selected",
        observedAt: now,
        indexedAt: now,
        deletedAt: null,
      },
    });
  await recordChange(tx, {
    kind: "projection",
    categories: [
      ...orderedEntityLockKinds(selected.map((entry) => entry.ref!.entityKind)),
      "search",
      "relatedData",
      "problems",
    ],
  });
}
