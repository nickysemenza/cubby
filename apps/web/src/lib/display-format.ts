import { wasmFormat } from "~/lib/wasm";

/** Shared empty-value wording; declared labels preserve their meaning. */
export function formatText(
  value: string | null | undefined,
  emptyLabel?: string,
  detail = false,
): string {
  return wasmFormat.format_text(value ?? undefined, emptyLabel, detail);
}
