import { z } from "zod";

/**
 * Browser-local state of the recount session and the location photo pass. Both
 * flows moved to the native app, so nothing in the web app can resume these
 * blobs any more; `RetiredFieldworkCleanup` offers a download of anything
 * unfinished, then removes the keys. The key prefixes and the pass envelope
 * mirror what the deleted `useQueuePass` wrote (envelope versions 3 and 4).
 */
const FLOWS = [
  { kind: "recount", prefix: "cubby:audit-session:" },
  { kind: "photo-pass", prefix: "cubby:photo-pass:" },
] as const;

type RetiredFieldworkKind = (typeof FLOWS)[number]["kind"];

type StorageLike = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;

const storedPassSchema = z.object({
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
  completed: z.array(z.string()),
  skipped: z.array(z.string()),
  totalCount: z.number().optional(),
  // Recount parks its staged, unsaved item decisions here.
  extra: z
    .object({ itemResolutions: z.array(z.unknown()) })
    .partial()
    .optional(),
});

export interface RetiredPass {
  key: string;
  kind: RetiredFieldworkKind;
  /** Location shortcode (recount) or scope key (photo pass). */
  scope: string;
  updatedAt: number | null;
  settledCount: number;
  totalCount: number;
  /** Recount decisions staged in the browser but never saved to the server. */
  stagedCount: number;
  /** The stored blob, verbatim, so a download loses nothing. */
  state: unknown;
}

function* retiredKeys(storage: StorageLike) {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const flow = FLOWS.find(({ prefix }) => key?.startsWith(prefix));
    if (key && flow) yield { key, flow };
  }
}

function parsePass(raw: string | null) {
  if (!raw) return null;
  try {
    const state: unknown = JSON.parse(raw);
    const pass = storedPassSchema.safeParse(state);
    return pass.success ? { state, pass: pass.data } : null;
  } catch {
    // SILENT: a corrupt blob has nothing worth offering; cleanup removes it.
    return null;
  }
}

/** Unfinished passes only: finished, empty, and unreadable ones carry no work. */
export function findRetiredFieldwork(storage: StorageLike): RetiredPass[] {
  const found: RetiredPass[] = [];
  for (const { key, flow } of retiredKeys(storage)) {
    const parsed = parsePass(storage.getItem(key));
    if (!parsed) continue;
    const { pass, state } = parsed;
    const settledCount = new Set([...pass.completed, ...pass.skipped]).size;
    const totalCount = pass.totalCount ?? 0;
    const stagedCount = pass.extra?.itemResolutions?.length ?? 0;
    if (settledCount >= totalCount && stagedCount === 0) continue;
    found.push({
      key,
      kind: flow.kind,
      scope: key.slice(flow.prefix.length),
      updatedAt: pass.updatedAt ?? pass.startedAt ?? null,
      settledCount,
      totalCount,
      stagedCount,
      state,
    });
  }
  return found.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function removeRetiredFieldwork(storage: StorageLike) {
  // Collect first: removing while iterating shifts the indexes.
  const keys = [...retiredKeys(storage)].map(({ key }) => key);
  for (const key of keys) storage.removeItem(key);
}

export function exportRetiredFieldwork(passes: readonly RetiredPass[]): string {
  return JSON.stringify(
    {
      note: "Unfinished recount and photo-pass state that was stored in this browser. Both workflows now run in the Cubby app.",
      exportedAt: new Date().toISOString(),
      passes: passes.map(({ key, kind, scope, state }) => ({
        key,
        kind,
        scope,
        state,
      })),
    },
    null,
    2,
  );
}
