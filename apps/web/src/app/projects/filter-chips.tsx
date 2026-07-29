import type { ReactNode } from "react";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";

/**
 * Shared chip primitives behind the /projects dashboard's toggle-style
 * filter rows — `FilterChipGroup` (multi-select) and `SingleSelectChipGroup`
 * (single-select). These are *toggle* chips (click to add/remove a filter
 * condition), not *removable* chips (an already-applied filter with a
 * dismiss affordance) — don't unify this with `ScopeChip` in
 * `data-table/ScopeChip.tsx`, which is the removable-chip abstraction for a
 * different surface. The only primitive the two share is `~/components/ui/badge`.
 */

interface ChipProps {
  label: string;
  /** The filter group this chip belongs to (e.g. "Status", "Date") — folded
   * into the accessible name so screen readers hear "Status: Planning,
   * toggle button" rather than just "Planning". */
  groupLabel: string;
  active: boolean;
  onClick: () => void;
}

/** The visual half, shared by both chip roles. */
function ChipBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <Badge variant={active ? "default" : "outline"} className="cursor-pointer">
      {label}
    </Badge>
  );
}

/**
 * Both group kinds render the same toggle button, deliberately.
 *
 * The single-select row is NOT a radiogroup: clicking the active option
 * *clears* it, which radio semantics don't allow (a radio can be switched but
 * never deselected). Announcing `role="radio"` would tell a screen-reader user
 * something false about what the control does. It's a toggle-button group
 * whose group happens to allow at most one pressed member, so `aria-pressed`
 * is the honest state, and the "(pick one)" hint carries the mutual exclusion
 * visually.
 */
function ToggleChip({ label, groupLabel, active, onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${groupLabel}: ${label}${active ? " (active)" : ""}`}
    >
      <ChipBadge label={label} active={active} />
    </button>
  );
}

function ChipRow({
  label,
  hint,
  children,
}: {
  label: string;
  /** Muted trailing hint text, e.g. "(pick one)" for single-select groups. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Row align="center" wrap gap="sm" role="group" aria-label={label}>
      <span className="font-medium text-muted-foreground text-xs">
        {label}:
      </span>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </Row>
  );
}

/** Multi-select chip row — any number of options may be active at once. */
export function FilterChipGroup({
  label,
  options,
  selected,
  onToggle,
  formatLabel = (v) => v,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  /** Human-facing label for a raw option value — defaults to identity. */
  formatLabel?: (value: string) => string;
}) {
  if (options.length === 0) return null;

  return (
    <ChipRow label={label}>
      {options.map((option) => (
        <ToggleChip
          key={option}
          label={formatLabel(option)}
          groupLabel={label}
          active={selected.has(option)}
          onClick={() => onToggle(option)}
        />
      ))}
    </ChipRow>
  );
}

/** Single-select chip row — at most one option is active; clicking the
 * active option clears the selection. Carries a muted "pick one" hint, since a
 * row of same-looking badges doesn't otherwise signal single- vs multi-select.
 * See `ToggleChip` for why this isn't a `radiogroup`. */
export function SingleSelectChipGroup({
  label,
  options,
  value,
  onChange,
  formatLabel = (v) => v,
  hint = "(pick one)",
}: {
  label: string;
  options: string[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** Human-facing label for a raw option value — defaults to identity. */
  formatLabel?: (value: string) => string;
  hint?: string;
}) {
  if (options.length === 0) return null;

  return (
    <ChipRow label={label} hint={hint}>
      {options.map((option) => (
        <ToggleChip
          key={option}
          label={formatLabel(option)}
          groupLabel={label}
          active={value === option}
          onClick={() => onChange(value === option ? null : option)}
        />
      ))}
    </ChipRow>
  );
}
