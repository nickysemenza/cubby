import type { WRichItem } from "@cubby/recipebridge";
import { match } from "ts-pattern";
import type { ReadonlyDeep } from "type-fest";

import { INGREDIENT_PART_COLOR } from "~/lib/ingredient-part-colors";
import { wasm } from "~/lib/wasm";

import { tryFormatAmount } from "../inventory/format-amount";

/**
 * Rich-text tokens for one instruction line, or the line as plain text when
 * the parser rejects it. The parser throws on some ordinary text (a digit run
 * followed by "e", read as an unfinished float exponent), and one bad line
 * must not take the whole recipe page down to its error boundary.
 */
export function parseRichTextSafe(
  text: string,
  ingredientNames: string[],
): WRichItem[] {
  try {
    return wasm.parse_rich_text(text, ingredientNames);
  } catch {
    return [{ kind: "Text", value: text }];
  }
}

export const formatRichText = (text: ReadonlyDeep<WRichItem[]>) => {
  return text.map((t, index) =>
    match(t)
      .with({ kind: "Text" }, (t) => t.value)
      .with({ kind: "Ing" }, (t) => (
        <span
          className="border-b-2 box-decoration-clone pb-px font-medium"
          style={{ borderBottomColor: INGREDIENT_PART_COLOR.name }}
          // oxlint-disable-next-line react/no-array-index-key -- Rich-text tokens are positional, can repeat identical content, and carry no stable id.
          key={index}
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
            style={{ borderBottomColor: INGREDIENT_PART_COLOR.amount }}
            // oxlint-disable-next-line react/no-array-index-key -- Rich-text tokens are positional, can repeat identical content, and carry no stable id.
            key={index}
          >
            {tryFormatAmount(val)}
          </span>
        );
      })
      .exhaustive(),
  );
};
