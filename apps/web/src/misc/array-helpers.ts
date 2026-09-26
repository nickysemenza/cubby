/**
 * Max ids per batched query. Pair with es-toolkit's `chunk` to bound database
 * and serialization work; sort input first for stable cache keys.
 */
export { ID_CHUNK_SIZE } from "@cubby/schemas/entity-media";
