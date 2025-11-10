import { type RichItem } from "@recipehub/recipebridge";
import { wasm } from "~/hooks/useWasm";
import { tryFormatMeasure } from "../inventory/format-amount";
import { assertNever } from "~/lib/assert";

export const formatRichText = (w: wasm, text: RichItem[]) => {
  return text.map((t, x) => {
    const { kind } = t;
    switch (kind) {
      case "Text":
        return t.value;
      case "Ing":
        return (
          <div
            className="text-foreground m-0 inline underline decoration-solid"
            key={x + "a"}
          >
            {t.value}
          </div>
        );
      case "Measure":
        const val = t.value.pop();
        if (!val) {
          return null;
        }
        if (val.unit === "whole") {
          val.unit = "";
        }
        return (
          <div
            className="text-accent-foreground m-0 inline underline decoration-solid"
            key={x}
          >
            {tryFormatMeasure(w, val)}
          </div>
        );
      default:
        return assertNever(kind);
    }
  });
};
