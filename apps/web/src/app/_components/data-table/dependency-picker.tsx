"use client";

import { Check, Pencil, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { getErrorMessage } from "~/lib/error-utils";

import type { PickerEntity } from "../combobox/combobox-types";
import { EntityPicker } from "../combobox/entity-picker";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";

export interface DependencyItem<TId extends string> {
  id: TId;
  name: string;
  icon?: ReactNode;
}

export interface DependencyPickerProps<TId extends string> {
  /** Current blocked-by set, resolved to names. */
  value: DependencyItem<TId>[];
  /** Full replacement id set — the server validates self-ref/dupes/missing
   * (see `replaceDependencyEdges`), so this just sends the whole next set. */
  onSave: (ids: TId[]) => Promise<void>;
  /** WithProjectSearch / WithTaskSearch — injected so unit tests can stub it. */
  SearchProvider: (props: WithEntitySearchProps<TId>) => ReactNode;
  /** Combobox placeholder noun, e.g. "project", "task". */
  label: Extract<PickerEntity, "project" | "task">;
  /** This entity's own id — excluded from pickable options client-side (the
   * server also rejects a self-reference). */
  excludeId: TId;
  /** Read-mode chip renderer (e.g. a Link-wrapped Badge to the detail page). */
  renderReadChip: (item: DependencyItem<TId>) => ReactNode;
}

/**
 * Editable "blocked by" dependency chips — the multi-entity sibling of
 * `EditableEntityCell`'s single-entity picker. Read mode renders
 * `renderReadChip` badges plus an Edit pencil; edit mode swaps to removable
 * chips and the shared Base UI entity picker with Save/Cancel. Save sends the FULL
 * replacement id set — `project.update` / `task.update`'s `blockedByIds`
 * replaces the edge set wholesale server-side.
 */
export function DependencyPicker<TId extends string>({
  value,
  onSave,
  SearchProvider,
  label,
  excludeId,
  renderReadChip,
}: DependencyPickerProps<TId>) {
  const [isEditing, setIsEditing] = useState(false);
  const [pending, setPending] = useState<DependencyItem<TId>[]>([]);
  const [isPending, setIsPending] = useState(false);

  const startEditing = () => {
    setPending(value);
    setIsEditing(true);
  };

  const handleSave = async () => {
    setIsPending(true);
    try {
      await onSave(pending.map((p) => p.id));
      setIsEditing(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsPending(false);
    }
  };

  if (!isEditing) {
    return (
      <Row wrap gap="sm" align="center">
        {value.length === 0 && (
          <span className="text-sm text-muted-foreground">None</span>
        )}
        {value.map((item) => (
          <span key={item.id}>{renderReadChip(item)}</span>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={startEditing}
          aria-label={`Edit blocked by ${label}s`}
        >
          <Pencil className="size-3 text-muted-foreground" />
        </Button>
      </Row>
    );
  }

  return (
    <Stack gap="xs">
      <Row wrap gap="xs" align="center">
        {pending.length === 0 && (
          <span className="text-sm text-muted-foreground">None</span>
        )}
        {pending.map((item) => (
          <Badge
            key={item.id}
            variant="outline"
            // Entity names — opt out of the mono-uppercase stamp.
            className="gap-1 pr-1 font-sans font-normal tracking-normal normal-case"
          >
            {item.icon}
            <span className="truncate">{item.name}</span>
            <button
              type="button"
              onClick={() =>
                setPending((prev) => prev.filter((p) => p.id !== item.id))
              }
              className="ml-1 rounded hover:bg-muted"
            >
              <X size={12} />
            </button>
          </Badge>
        ))}
      </Row>
      <Row gap="sm" align="center">
        <SearchProvider>
          {({ items, onSearchChange, isLoading, onOpenChange }) => (
            <EntityPicker
              entity={label}
              label={label}
              items={items.map((item) => {
                const disabledReason =
                  item.id === excludeId
                    ? `This is the current ${label}`
                    : pending.some((candidate) => candidate.id === item.id)
                      ? "Already selected"
                      : undefined;
                return disabledReason
                  ? {
                      ...item,
                      presentation: {
                        ...item.presentation,
                        group: {
                          id: "unavailable",
                          label: "Unavailable",
                          order: 99,
                        },
                        disabledReason,
                      },
                    }
                  : item;
              })}
              onSearchChange={onSearchChange}
              isLoading={isLoading}
              value={null}
              setValue={(item) => {
                if (item) setPending((prev) => [...prev, item]);
              }}
              onOpenChange={onOpenChange}
            />
          )}
        </SearchProvider>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void handleSave()}
          disabled={isPending}
        >
          <Check className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setIsEditing(false)}
          disabled={isPending}
        >
          <X className="size-3.5" />
        </Button>
      </Row>
    </Stack>
  );
}
