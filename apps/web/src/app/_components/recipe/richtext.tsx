import type { RichItem } from "@cubby/recipebridge";
import type { ReadonlyDeep } from "type-fest";
import { assertNever } from "~/lib/assert";
import { tryFormatAmount } from "../inventory/format-amount";

export const formatRichText = (text: ReadonlyDeep<RichItem[]>) => {
  return text.map((t, x) => {
    const { kind } = t;
    switch (kind) {
      case "Text":
        return t.value;
      case "Ing":
        return (
          <span
            className="rounded-sm bg-accent/20 box-decoration-clone px-1 font-medium text-accent-foreground"
            // biome-ignore lint/suspicious/noArrayIndexKey: RichItem array has no stable IDs
            key={x}
          >
            {t.value}
          </span>
        );
      case "Measure": {
        // Read the last amount without mutating t.value — wasm.parse_rich_text
        // results are cached/shared and must be treated as immutable.
        const last = t.value.at(-1);
        if (!last) {
          return null;
        }
        const val = last.unit === "whole" ? { ...last, unit: "" } : last;
        return (
          <span
            className="rounded-sm bg-secondary box-decoration-clone px-1 font-medium text-secondary-foreground"
            // biome-ignore lint/suspicious/noArrayIndexKey: RichItem array has no stable IDs
            key={x}
          >
            {tryFormatAmount(val)}
          </span>
        );
      }
      default:
        return assertNever(kind);
    }
  });
};
