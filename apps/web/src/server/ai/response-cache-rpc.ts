// The global Worker binding types reach this contract. Keep its imports and
// signatures independent of the cache client and AI implementation graph.
export const AI_RESPONSE_CACHE_BATCH_SIZE = 128;

export type CacheClaim =
  | { kind: "hit"; value: string }
  | { kind: "busy" }
  | { kind: "claimed"; token: string };

export interface AiResponseCacheRpc {
  readOrClaim(key: string, force: boolean): CacheClaim;
  readOrClaimMany(
    requests: readonly { key: string; force: boolean }[],
  ): CacheClaim[];
  renew(key: string, token: string): boolean;
  publish(
    key: string,
    token: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean>;
  release(key: string, token: string): void;
  invalidate(key: string, value: string): void;
}
