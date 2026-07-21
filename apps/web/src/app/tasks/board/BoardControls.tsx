import { Row } from "~/components/layout";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import type { BoardColsMode, BoardLaneMode } from "./board-model";

const COLS_OPTIONS: ViewSwitcherOption<BoardColsMode>[] = [
  { value: "status", label: "Status" },
  { value: "project", label: "Project" },
  { value: "trade", label: "Trade" },
];

type LaneChoice = "none" | BoardLaneMode;
const LANE_OPTIONS: ViewSwitcherOption<LaneChoice>[] = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
  { value: "trade", label: "Trade" },
];

interface BoardControlsProps {
  cols: BoardColsMode;
  /** Effective swimlane axis (null = none); only offered when `cols === "status"`. */
  lane: BoardLaneMode | null;
  onColsChange: (cols: BoardColsMode) => void;
  onLaneChange: (lane: BoardLaneMode | null) => void;
}

/** The `/tasks` board's two toggle groups: column axis + (status-only) swimlanes. */
export function BoardControls({
  cols,
  lane,
  onColsChange,
  onLaneChange,
}: BoardControlsProps) {
  return (
    <Row align="center" gap="md" wrap>
      <Row align="center" gap="sm">
        <span className="text-muted-foreground text-sm">Columns</span>
        <ViewSwitcher
          ariaLabel="Board columns"
          options={COLS_OPTIONS}
          value={cols}
          onValueChange={onColsChange}
        />
      </Row>
      {cols === "status" && (
        <Row align="center" gap="sm">
          <span className="text-muted-foreground text-sm">Group by</span>
          <ViewSwitcher
            ariaLabel="Board swimlanes"
            options={LANE_OPTIONS}
            value={lane ?? "none"}
            onValueChange={(v) => onLaneChange(v === "none" ? null : v)}
          />
        </Row>
      )}
    </Row>
  );
}
