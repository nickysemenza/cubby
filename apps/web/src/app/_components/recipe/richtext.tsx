import type { RichItem } from "@cubby/recipebridge";
import { match } from "ts-pattern";
import type { ReadonlyDeep } from "type-fest";
import { tryFormatAmount } from "../inventory/format-amount";

export const formatRichText = (text: ReadonlyDeep<RichItem[]>) => {
  return text.map((t, x) =>
    match(t)
      .with({ kind: "Text" }, (t) => t.value)
      .with({ kind: "Ing" }, (t) => (
        <span
          className="border-b-2 box-decoration-clone pb-px font-medium"
          style={{ borderBottomColor: "var(--ingredient-name)" }}
          // biome-ignore lint/suspicious/noArrayIndexKey: RichItem array has no stable IDs
          key={x}
        >
          {t.value}
        </span>
      ))
      .with({ kind: "Measure" }, (t) => {
        // Read the last amount without mutating t.value — wasm.parse_rich_text
        // results are cached/shared and must be treated as immutable.
        const last = t.value.at(-1);
        if (!last) {
          return null;
        }
        const val = last.unit === "whole" ? { ...last, unit: "" } : last;
        return (
          <span
            className="border-b-2 box-decoration-clone pb-px font-medium"
            style={{ borderBottomColor: "var(--ingredient-amount)" }}
            // biome-ignore lint/suspicious/noArrayIndexKey: RichItem array has no stable IDs
            key={x}
          >
            {tryFormatAmount(val)}
          </span>
        );
      })
      .exhaustive(),
  );
};
