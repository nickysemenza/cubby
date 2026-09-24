import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";

import { Row } from "~/components/layout";
import { Input } from "~/components/ui/input";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { cn } from "~/lib/utils";

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
  /** Live search text — filters cards client-side (name + project name). */
  search: string;
  onSearchChange: (value: string) => void;
}

/** The `/tasks` board's controls: column axis + (status-only) swimlanes + search. */
export function BoardControls({
  cols,
  lane,
  onColsChange,
  onLaneChange,
  search,
  onSearchChange,
}: BoardControlsProps) {
  return (
    <Row align="center" justify="between" gap="md" wrap>
      <Row align="center" gap="md" wrap className="hidden md:flex">
        <Row align="center" gap="sm">
          <span className="text-sm text-muted-foreground">Columns</span>
          <ViewSwitcher
            ariaLabel="Board columns"
            options={COLS_OPTIONS}
            value={cols}
            onValueChange={onColsChange}
          />
        </Row>
        {cols === "status" && (
          <Row align="center" gap="sm">
            <span className="text-sm text-muted-foreground">Group by</span>
            <ViewSwitcher
              ariaLabel="Board swimlanes"
              options={LANE_OPTIONS}
              value={lane ?? "none"}
              onValueChange={(v) => onLaneChange(v === "none" ? null : v)}
            />
          </Row>
        )}
      </Row>
      <div className="relative w-full sm:w-56">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search tasks…"
          aria-label="Search board tasks"
          className={cn("pl-8", search && "pr-6")}
        />
        {search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onSearchChange("")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </Row>
  );
}
