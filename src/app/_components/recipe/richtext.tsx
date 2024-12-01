import { format_amount, type RichItem } from "recipebridge/pkg/recipebridge";

export const formatRichText = (text: RichItem[]) => {
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
        let val = t.value.pop();
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
            {format_amount(val)}
          </div>
        );
      default:
        const exhaustiveCheck: never = t;
        throw new Error(`Unhandled case: ${exhaustiveCheck}`);
    }
  });
};
