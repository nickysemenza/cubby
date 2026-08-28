import type { SHEET_LAYOUTS, SheetFormat } from "./sheet-layouts";

export function PrintStyles({
  layout,
}: {
  layout: (typeof SHEET_LAYOUTS)[SheetFormat];
}) {
  const n = layout.labelsPerSheet;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
          @media print {
            @page { size: letter; margin: ${layout.pageMargin}; }
            body > *:not(.label-sheet) { display: none; }
            .label-sheet { display: grid !important; }
            .label-sheet > div:nth-child(${n}n+1) { break-before: page; }
            .label-sheet > div:nth-child(-n+${n}) { break-before: auto; }
          }
        `,
      }}
    />
  );
}
