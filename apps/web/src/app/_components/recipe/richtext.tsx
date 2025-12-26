import type { RichItem } from "@recipehub/recipebridge";
import { tryFormatAmount } from "../inventory/format-amount";
import { assertNever } from "~/lib/assert";

export const formatRichText = (text: RichItem[]) => {
  return text.map((t, x) => {
    const { kind } = t;
    switch (kind) {
      case "Text":
        return t.value;
      case "Ing":
        return (
          <span
            className="inline-flex items-center rounded bg-orange-50 px-1.5 py-0.5 font-medium text-orange-600 text-sm dark:bg-orange-950 dark:text-orange-400"
            key={`${x}a`}
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
            className="inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 font-medium text-green-800 text-sm dark:bg-green-900/30 dark:text-green-400"
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
