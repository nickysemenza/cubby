import { Badge } from "~/ui/reui/badge";

export function SubtaskProgress({
  done,
  total,
}: {
  done: number;
  total: number;
}) {
  return total > 0 ? (
    <Badge variant="outline">
      {done}/{total}
    </Badge>
  ) : null;
}
