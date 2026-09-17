import type {
  VectorizeMatches,
  VectorizeQueryOptions,
  VectorizeVector,
} from "@cloudflare/workers-types";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { searchableEntitySchema } from "@cubby/schemas/search";
import { z } from "zod";

import { getVectorIndex } from "~/server/cf-env";

/**
 * The slice of the Cloudflare Vectorize (v2) binding Cubby uses. Declared here
 * rather than taken from the generated `Env` type because `wrangler types`
 * emits the legacy `VectorizeIndex` class, which lacks `queryById`; the
 * runtime binding has it. Tests satisfy this with
 * {@link createInMemoryVectorizeIndex} via `setCfEnv`, the same way queues
 * are faked — one fake at the binding boundary, no parallel port fake.
 */
export interface VectorizeIndexBinding {
  query(
    vector: number[],
    options?: VectorizeQueryOptions,
  ): Promise<VectorizeMatches>;
  queryById(
    vectorId: string,
    options?: VectorizeQueryOptions,
  ): Promise<VectorizeMatches>;
  upsert(vectors: VectorizeVector[]): Promise<VectorizeMutation>;
  deleteByIds(ids: string[]): Promise<VectorizeMutation>;
}

/** Mutations are async on Vectorize; the id is the only thing it returns. */
interface VectorizeMutation {
  mutationId: string;
}

export interface VectorMatch extends SearchableEntityRef {
  similarity: number;
}

interface StoredVector extends SearchableEntityRef {
  values: number[];
}

interface VectorQueryOptions {
  entityTypes?: SearchableEntity[];
  topK: number;
}

/**
 * Where entity vectors live. Postgres keeps only the slim `EntityEmbedding`
 * row (hash + model bookkeeping); the vector itself is here. Every consumer
 * checks {@link VectorStorePort.configured} through
 * `semanticEmbeddingsConfigured()` before calling anything else, so an absent
 * binding (the vite Node dev server) degrades to "unavailable" rather than
 * throwing.
 */
export interface VectorStorePort {
  configured(): boolean;
  upsert(vectors: ReadonlyArray<StoredVector>): Promise<void>;
  deleteByIds(refs: ReadonlyArray<SearchableEntityRef>): Promise<void>;
  query(vector: number[], opts: VectorQueryOptions): Promise<VectorMatch[]>;
  queryById(
    ref: SearchableEntityRef,
    opts: VectorQueryOptions,
  ): Promise<VectorMatch[]>;
}

/**
 * Deterministic id so upsert is idempotent and delete needs no lookup.
 * Longest entity name (`financialTransaction`, 20) + `:` + uuid (36) = 57
 * bytes, under Vectorize's 64-byte id limit.
 */
export const vectorId = (ref: SearchableEntityRef): string =>
  `${ref.entityType}:${ref.entityId}`;

const parseVectorId = (id: string): SearchableEntityRef | undefined => {
  const separator = id.indexOf(":");
  if (separator === -1) return undefined;
  const entityType = searchableEntitySchema.safeParse(id.slice(0, separator));
  if (!entityType.success) return undefined;
  return { entityType: entityType.data, entityId: id.slice(separator + 1) };
};

/** Vectorize caps a single Worker `upsert`/`deleteByIds` at 1000 vectors. */
const MUTATION_BATCH = 1000;

const chunk = <T>(items: ReadonlyArray<T>, size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
};

const queryOptions = (opts: VectorQueryOptions): VectorizeQueryOptions => {
  const options: VectorizeQueryOptions = {
    topK: opts.topK,
    returnMetadata: "none",
  };
  // Filter runs before topK, so the caller gets up to `topK` matching rows.
  // `entityType` is the only metadata index (low cardinality by design).
  if (opts.entityTypes && opts.entityTypes.length > 0) {
    options.filter = { entityType: { $in: opts.entityTypes } };
  }
  return options;
};

const toMatches = (matches: VectorizeMatches): VectorMatch[] =>
  matches.matches.flatMap((match) => {
    const ref = parseVectorId(match.id);
    return ref ? [{ ...ref, similarity: match.score }] : [];
  });

const requireIndex = (): VectorizeIndexBinding => {
  const index = getVectorIndex();
  if (!index)
    throw new Error(
      "Vectorize binding is not configured; gate on semanticEmbeddingsConfigured() first.",
    );
  return index;
};

export const productionVectorStore: VectorStorePort = {
  configured: () => getVectorIndex() !== undefined,
  async upsert(vectors) {
    const index = requireIndex();
    for (const batch of chunk(vectors, MUTATION_BATCH)) {
      await index.upsert(
        batch.map((vector) => ({
          id: vectorId(vector),
          values: vector.values,
          metadata: { entityType: vector.entityType },
        })),
      );
    }
  },
  async deleteByIds(refs) {
    const index = requireIndex();
    for (const batch of chunk(refs, MUTATION_BATCH)) {
      await index.deleteByIds(batch.map(vectorId));
    }
  },
  async query(vector, opts) {
    return toMatches(await requireIndex().query(vector, queryOptions(opts)));
  },
  async queryById(ref, opts) {
    return toMatches(
      await requireIndex().queryById(vectorId(ref), queryOptions(opts)),
    );
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
const entityTypeFilterSchema = z.object({
  entityType: z.object({ $in: z.array(searchableEntitySchema) }),
});
const storedMetadataSchema = z.object({ entityType: searchableEntitySchema });

const filterEntityTypes = (
  options: VectorizeQueryOptions | undefined,
): Set<SearchableEntity> | undefined => {
  const parsed = entityTypeFilterSchema.safeParse(options?.filter);
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
    const allowed = filterEntityTypes(options);
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
    async upsert(input) {
      for (const vector of input) vectors.set(vector.id, vector);
      return { mutationId: "in-memory" };
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "in-memory" };
    },
  };
}
