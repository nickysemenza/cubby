import { OptionGlyph } from "~/ui/media/option-glyph";

/**
 * What kind of record this is, as a small tag with the option's glyph. Drawn
 * in the title cell at full width and in the detail header. It names the
 * kind; colour is not used.
 */
export function KindTag({
  option,
}: {
  option: { label: string; glyph?: { phosphor: string } };
}) {
  return (
    <span
      data-kind-tag=""
      className="inline-flex h-4.5 shrink-0 items-center gap-1 rounded-(--brand-web-radius-chip) bg-muted pr-1.5 pl-1.25 text-2xs font-medium whitespace-nowrap text-foreground"
    >
      {option.glyph ? (
        <OptionGlyph
          name={option.glyph.phosphor}
          weight="bold"
          className="size-3 text-muted-foreground"
        />
      ) : null}
      {option.label}
    </span>
  );
}
