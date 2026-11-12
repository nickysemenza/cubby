import { AsyncLocalStorage } from "node:async_hooks";

const memos = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** One memo per inbound HTTP request; queue, cron and Durable Object work has none. */
export const withRequestMemo = <T>(run: () => Promise<T>): Promise<T> =>
  memos.run(new Map(), run);

/**
 * Share one in-flight or settled read among the callers of a single inbound
 * request, such as the SSR route guard and the in-process operations it renders.
 * A rejection is forgotten so the next caller retries. Outside a request scope
 * every call reads.
 */
export function memoizeInRequest<T>(
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const memo = memos.getStore();
  if (!memo) return read();
  // SAFETY: a key names one read, so every caller supplies the same T.
  const existing = memo.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = read();
  memo.set(key, pending);
  pending.catch(() => memo.delete(key));
  return pending;
}
