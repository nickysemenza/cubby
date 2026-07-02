import { Description } from "~/components/ui/description";

export function LabelSummary({
  labelCount,
  skip,
  labelsPerSheet,
}: {
  labelCount: number;
  skip: number;
  labelsPerSheet: number;
}) {
  const totalSlots = labelCount + skip;
  const pages = totalSlots / labelsPerSheet;
  const pagesDisplay = pages % 1 === 0 ? pages.toString() : pages.toFixed(1);
  return (
    <Description>
      {labelCount} label{labelCount !== 1 && "s"}, {pagesDisplay} page
      {pages !== 1 && "s"}
    </Description>
  );
}
