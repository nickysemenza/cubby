import type {
  VectorizeMatches,
  VectorizeQueryOptions,
  VectorizeVector,
} from "@cloudflare/workers-types";
import type { SearchableEntity } from "@cubby/schemas/search";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { chunk } from "es-toolkit";
import { z } from "zod";

import { getVectorIndex } from "~/server/cf-env";

interface VectorizeMutation {
  mutationId: string;
}

/** The v2 binding surface; mutations are accepted before they become queryable. */
export interface VectorizeIndexBinding {
  query(
    vector: number[],
    options?: VectorizeQueryOptions,
  ): Promise<VectorizeMatches>;
  queryById(
    id: string,
    options?: VectorizeQueryOptions,
  ): Promise<VectorizeMatches>;
  getByIds(ids: string[]): Promise<VectorizeVector[]>;
  upsert(vectors: VectorizeVector[]): Promise<VectorizeMutation>;
  deleteByIds(ids: string[]): Promise<VectorizeMutation>;
}

export interface PhysicalVectorMatch {
  id: string;
  similarity: number;
}
interface StoredVector {
  id: string;
  entityKind: SearchableEntity;
  values: number[];
}
interface VectorQueryOptions {
  entityKinds?: SearchableEntity[];
  topK: number;
}

/** Physical IDs identify immutable artifacts, never mutable entity slots. */
export interface VectorStorePort {
  configured(): boolean;
  upsert(vectors: ReadonlyArray<StoredVector>): Promise<Map<string, string>>;
  deleteByIds(ids: readonly string[]): Promise<Map<string, string>>;
  getByIds(ids: readonly string[]): Promise<{ id: string; values: number[] }[]>;
  query(
    vector: number[],
    options: VectorQueryOptions,
  ): Promise<PhysicalVectorMatch[]>;
  queryById(
    id: string,
    options: VectorQueryOptions,
  ): Promise<PhysicalVectorMatch[]>;
}

const MUTATION_BATCH = 1000;
/** Vectorize rejects `getByIds` with more than 20 ids (VECTOR_GET_ERROR 40007). */
const VECTOR_GET_BATCH = 20;
const queryOptions = (options: VectorQueryOptions): VectorizeQueryOptions => ({
  topK: Math.min(100, Math.max(1, options.topK)),
  returnMetadata: "none",
  ...(options.entityKinds?.length
    ? { filter: { entityType: { $in: options.entityKinds } } }
    : {}),
});
const matchSchema = z.object({ id: z.string(), score: z.number() });
const observationSchema = z.object({
  id: z.string(),
  values: z.array(z.number()),
});
const toMatches = (matches: VectorizeMatches): PhysicalVectorMatch[] =>
  z
    .array(matchSchema)
    .parse(matches.matches)
    .map(({ id, score }) => ({ id, similarity: score }));
const requireIndex = (): VectorizeIndexBinding => {
  const index = getVectorIndex();
  if (!index) throw new Error("Vectorize binding is not configured");
  return index;
};

export const productionVectorStore: VectorStorePort = {
  configured: () => getVectorIndex() !== undefined,
  async upsert(vectors) {
    const receipts = new Map<string, string>();
    for (const batch of chunk(vectors, MUTATION_BATCH)) {
      const receipt = await requireIndex().upsert(
        batch.map(({ id, values, entityKind }) => ({
          id,
          values,
          metadata: { entityType: entityKind },
        })),
      );
      for (const vector of batch) receipts.set(vector.id, receipt.mutationId);
    }
    return receipts;
  },
  async deleteByIds(ids) {
    const receipts = new Map<string, string>();
    for (const batch of chunk(ids, MUTATION_BATCH)) {
      const receipt = await requireIndex().deleteByIds(batch);
      for (const id of batch) receipts.set(id, receipt.mutationId);
    }
    return receipts;
  },
  async getByIds(ids) {
    const vectors = [];
    for (const batch of chunk(ids, VECTOR_GET_BATCH)) {
      const observed = await requireIndex().getByIds(batch);
      vectors.push(
        ...z.array(observationSchema).parse(
          observed.map((vector) => ({
            id: vector.id,
            values: [...vector.values],
          })),
        ),
      );
    }
    return vectors;
  },
  async query(vector, options) {
    return toMatches(await requireIndex().query(vector, queryOptions(options)));
  },
  async queryById(id, options) {
    return toMatches(await requireIndex().queryById(id, queryOptions(options)));
  },
};

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const denominator = Math.sqrt(na) * Math.sqrt(nb);
  return denominator === 0 ? 0 : dot / denominator;
};

/** The only filter shape the production store emits (see `queryOptions`). */
const entityKindFilterSchema = z.object({
  entityType: z.object({ $in: z.array(searchableEntitySchema) }),
});
const storedMetadataSchema = z.object({ entityType: searchableEntitySchema });

const filterEntityKinds = (
  options: VectorizeQueryOptions | undefined,
): Set<SearchableEntity> | undefined => {
  const parsed = entityKindFilterSchema.safeParse(options?.filter);
  return parsed.success ? new Set(parsed.data.entityType.$in) : undefined;
};

/**
 * Brute-force cosine search over a Map, for tests. Implements the binding
 * surface so `setCfEnv(fromPartial<Env>({ VECTORIZE: createInMemoryVectorizeIndex() }))`
 * is the whole setup. Unlike the real index it is strongly consistent.
 */
export function createInMemoryVectorizeIndex(): VectorizeIndexBinding & {
  readonly vectors: ReadonlyMap<string, VectorizeVector>;
} {
  const vectors = new Map<string, VectorizeVector>();
  const search = (
    vector: number[],
    options: VectorizeQueryOptions | undefined,
  ): VectorizeMatches => {
    const allowed = filterEntityKinds(options);
    const matches = [...vectors.values()]
      .filter((stored) => {
        if (!allowed) return true;
        const metadata = storedMetadataSchema.safeParse(stored.metadata);
        return metadata.success && allowed.has(metadata.data.entityType);
      })
      .map((stored) => ({
        id: stored.id,
        score: cosine(vector, [...stored.values]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.topK ?? 5);
    return { count: matches.length, matches };
  };
  return {
    vectors,
    async query(vector, options) {
      return search(vector, options);
    },
    async queryById(id, options) {
      const seed = vectors.get(id);
      // The seed is returned like any other match (score 1); callers drop it
      // themselves, which also covers the real index if it behaves the same.
      return seed
        ? search([...seed.values], options)
        : { count: 0, matches: [] };
    },
    async getByIds(ids) {
      // Same limit as the real index, so batched callers fail here too.
      if (ids.length > VECTOR_GET_BATCH)
        throw new Error(
          `VECTOR_GET_ERROR (code = 40007): too many ids in payload; max id count is ${VECTOR_GET_BATCH}, got ${ids.length}`,
        );
      return ids.flatMap((id) => {
        const vector = vectors.get(id);
        return vector ? [vector] : [];
      });
    },
    async upsert(input) {
      for (const vector of input) vectors.set(vector.id, vector);
      return { mutationId: crypto.randomUUID() };
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: crypto.randomUUID() };
    },
  };
}
