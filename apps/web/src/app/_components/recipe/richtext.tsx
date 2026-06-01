import type { RichItem } from "@cubby/recipebridge";
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
            className="rounded-sm bg-accent/20 box-decoration-clone px-1 font-medium text-accent-foreground"
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
