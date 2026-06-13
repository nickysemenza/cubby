import { INGREDIENT_PART_COLOR } from "~/lib/ingredient-part-colors";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

/**
 * Renders the grammar's carve of a raw ingredient line: the source text with a
 * colored underline under each amount / name / modifier span, drawn on the line
 * itself rather than broken into separate fields. The segmentation runs in Rust
 * (`decompose_ingredient`) and returns ordered `{ text, field? }` chunks that
 * concatenate back to the source, so there is no byte-offset math here — labeled
 * chunks get an underline, gap chunks render plain.
 *
 * The displayed text is `decomposition.source`, the *normalized* line the spans
 * index into — not the verbatim raw input (unicode fractions, whitespace, etc.
 * may be rewritten). When a whole-line recognizer or the name-only fallback
 * produced the result, `segments` is a single unlabeled chunk and the line
 * renders plain — no special-casing needed.
 */
export function DecompositionView({
  rawLine,
  className,
}: {
  rawLine: string;
  className?: string;
}) {
  const { segments } = wasm.decompose_ingredient(rawLine);

  return (
    <span className={cn("font-mono", className)}>
      {segments.map((seg, i) =>
        seg.field ? (
          <span
            className="border-b-2 box-decoration-clone pb-px"
            style={{ borderBottomColor: INGREDIENT_PART_COLOR[seg.field] }}
            // biome-ignore lint/suspicious/noArrayIndexKey: segments have no stable IDs, order is stable
            key={i}
            title={seg.field}
          >
            {seg.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments have no stable IDs, order is stable
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}
