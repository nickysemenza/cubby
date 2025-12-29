import type { RichItem } from "@recipehub/recipebridge";
import { assertNever } from "~/lib/assert";
import { tryFormatAmount } from "../inventory/format-amount";

export const formatRichText = (text: RichItem[]) => {
  return text.map((t, x) => {
    const { kind } = t;
    switch (kind) {
      case "Text":
        return t.value;
      case "Ing":
        return (
          <span
            className="inline-flex items-center rounded bg-accent/20 px-1.5 py-0.5 font-medium text-accent-foreground text-sm"
            // biome-ignore lint/suspicious/noArrayIndexKey: RichItem array has no stable IDs
            key={x}
          >
            {t.value}
          </span>
        );
      case "Measure": {
        const val = t.value.pop();
        if (!val) {
          return null;
        }
        if (val.unit === "whole") {
          val.unit = "";
        }
        return (
          <span
            className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 font-medium text-secondary-foreground text-sm"
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
