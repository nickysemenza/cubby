import { type RichItem } from "recipebridge/pkg/recipebridge";
import { wasm } from "~/wasmContext";

export const formatRichText = (w: wasm, text: RichItem[]) => {
  return text.map((t, x) => {
    switch (t.kind) {
      case "Text":
        return t.value;
      case "Ing":
        return (
          <div
            className="decoration-grey m-0 inline text-orange-800 underline decoration-solid"
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
            className="decoration-grey m-0 inline text-green-800 underline decoration-solid"
            key={x}
          >
            TODO
            {/* {w.format_amount(val)} */}
          </div>
        );
    }
  });
};
