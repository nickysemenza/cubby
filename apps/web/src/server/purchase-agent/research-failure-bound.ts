import { sha256Hex } from "@cubby/shared/sha256";
import { scrubErrorMessage } from "@cubby/worker-tracing/scrub-error-message";
import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";

/** Uses the Run agent's existing durable state and atomic SQLite transaction. */
export async function recordResearchToolOutcome(
  store: {
    read(key: string): string | undefined;
    write(key: string, value: string): void;
    atomic(effect: () => string | undefined): string | undefined;
  },
  tool: string,
  args: JsonValue,
  callId: string,
  error?: string,
): Promise<string | undefined> {
  const action = await sha256Hex(JSON.stringify([tool, args]));
  const diagnostic = error === undefined ? undefined : scrubErrorMessage(error);
  const failure =
    diagnostic === undefined ? undefined : await sha256Hex(diagnostic);
  const outcome = await sha256Hex(JSON.stringify([callId, diagnostic]));
  return store.atomic(() => {
    const receiptKey = `research_tool_outcome:${action}:${outcome}`;
    const receipt = store.read(receiptKey);
    if (receipt !== undefined) return receipt || undefined;
    const failuresKey = `research_tool_failures:${action}`;
    const failures = z
      .record(z.string(), z.number().int().nonnegative())
      .parse(JSON.parse(store.read(failuresKey) ?? "{}"));
    let detail: string | undefined;
    if (diagnostic === undefined) store.write(failuresKey, "{}");
    else {
      const count = (failures[failure!] ?? 0) + 1;
      failures[failure!] = count;
      store.write(failuresKey, JSON.stringify(failures));
      if (count >= 3)
        detail = `Research stopped after three distinct calls repeated an unchanged ${tool} failure: ${diagnostic}. Unfinished work remains for review; no verification or completion is claimed.`;
    }
    store.write(receiptKey, detail ?? "");
    return detail;
  });
}
