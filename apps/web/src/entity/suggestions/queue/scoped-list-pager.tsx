import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

export function ScopedListPager({
  offset,
  itemCount,
  totalCount,
  nextOffset,
  onOffsetChange,
}: {
  offset: number;
  itemCount: number;
  totalCount: number;
  nextOffset: number | null;
  onOffsetChange: (offset: number) => void;
}) {
  if (totalCount <= 50) return null;
  return (
    <Row gap="sm">
      <Button
        size="sm"
        variant="outline"
        disabled={offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - 50))}
      >
        Previous
      </Button>
      <span className="text-xs tabular-nums">
        {offset + 1}–{offset + itemCount} of {totalCount}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={nextOffset === null}
        onClick={() => {
          if (nextOffset !== null) onOffsetChange(nextOffset);
        }}
      >
        Next
      </Button>
    </Row>
  );
}
