import type * as RB from "@cubby/recipebridge";

// On-device recipebridge by running the exact web WASM inside a hidden
// react-native-webview (WKWebView = a real browser with WebAssembly + JIT, so
// externref/reference-types work unchanged — unlike Hermes). Calls cross the
// webview messaging bridge, so the API is async; types come from
// @cubby/recipebridge's .d.ts (Promise-wrapped). Mount <RecipebridgeHost/> once.

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

const pending = new Map<number, Pending>();
let idCounter = 0;
let postToHost: ((s: string) => void) | null = null;
let resolveReady: (() => void) | null = null;
const ready = new Promise<void>((r) => {
  resolveReady = r;
});

/** Called by <RecipebridgeHost/> for every message from the WebView. */
export function handleHostMessage(raw: string): void {
  let msg: {
    type: string;
    id?: number;
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "ready") {
    resolveReady?.();
    return;
  }
  if (msg.type === "error") {
    console.error("[recipebridge] host init failed:", msg.error);
    return;
  }
  if (msg.type === "result" && msg.id != null) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "recipebridge error"));
  }
}

/** Wire the WebView's postMessage; called by <RecipebridgeHost/>. */
export function setHostPoster(poster: ((s: string) => void) | null): void {
  postToHost = poster;
}

function call<T>(method: string, args: unknown[]): Promise<T> {
  return ready.then(
    () =>
      new Promise<T>((resolve, reject) => {
        const id = ++idCounter;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        postToHost?.(JSON.stringify({ type: "call", id, method, args }));
      }),
  );
}

type BatchResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Run many calls in a single round-trip; returns per-call ok/result|error. */
function callBatch(
  calls: { method: string; args: unknown[] }[],
): Promise<BatchResult[]> {
  if (calls.length === 0) return Promise.resolve([]);
  return ready.then(
    () =>
      new Promise<BatchResult[]>((resolve, reject) => {
        const id = ++idCounter;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        postToHost?.(JSON.stringify({ type: "batch", id, calls }));
      }),
  );
}

/** Format many amounts in one round-trip (null where a single format failed). */
export async function formatAmounts(
  amounts: RB.WAmount[],
): Promise<(string | null)[]> {
  const res = await callBatch(
    amounts.map((a) => ({ method: "format_amount", args: [{ ...a }] })),
  );
  return res.map((r) => (r.ok ? (r.result as string) : null));
}

// Async mirror of the @cubby/recipebridge API (add wrappers as screens need them;
// `call` already reaches every exported function for free).
export const recipebridge = {
  parse_ingredient: (line: string) =>
    call<ReturnType<typeof RB.parse_ingredient>>("parse_ingredient", [line]),
  parse_yield: (s: string) =>
    call<ReturnType<typeof RB.parse_yield>>("parse_yield", [s]),
  format_amount: (a: RB.WAmount) => call<string>("format_amount", [{ ...a }]),
  /** Generic escape hatch for any other recipebridge export. */
  call,
};
