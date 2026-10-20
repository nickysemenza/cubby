import { Description } from "~/ui/primitives/description";

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
  const pages = Math.ceil(totalSlots / labelsPerSheet);
  return (
    <Description>
      {labelCount} label{labelCount !== 1 && "s"}, {pages} page
      {pages !== 1 && "s"}
    </Description>
  );
}
