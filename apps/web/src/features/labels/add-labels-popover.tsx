import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { countLabel } from "@cubby/shared/pluralize";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { useQueryClient } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { useState } from "react";
import { toast } from "sonner";

import { entityDetailFor } from "~/entity/entity-detail";
import { typeSupportsQrCode } from "~/features/location/location-type-theme";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { EntityReferencePicker } from "~/ui/combobox/entity-reference-picker";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

/**
 * Adds a location's label, or every QR-eligible child's, to the sheet. The
 * location is chosen with the shared location picker; the two actions apply
 * to the chosen record.
 */
export function AddLabelsPopover({
  codes,
  onCodesChange,
}: {
  codes: string | undefined;
  onCodesChange: (newCodes: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] =
    useState<ComboboxItem<LocationShortcode> | null>(null);

  function mergeCodes(newShortcodes: string[]) {
    const existing =
      codes
        ?.split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0) ?? [];
    const merged = uniq([...existing, ...newShortcodes]);
    onCodesChange(merged.join(","));
  }

  async function handleAddSingle(location: {
    id: LocationShortcode;
    name: string;
  }) {
    const full = await queryClient.fetchQuery(
      entityDetailFor("location").queryOptions(location.id),
    );
    if (!full) {
      toast.warning(`${location.name} no longer exists`);
      return;
    }
    if (!typeSupportsQrCode(full.type)) {
      toast.warning(
        `${location.name} is a ${full.type} and doesn't support QR labels`,
      );
      return;
    }
    mergeCodes([location.id]);
    toast.success(`Added ${location.name}`);
  }

  async function handleAddChildren(location: {
    id: LocationShortcode;
    name: string;
  }) {
    const full = await queryClient.fetchQuery(
      entityDetailFor("location").queryOptions(location.id),
    );
    if (!full) {
      toast.warning(`${location.name} no longer exists`);
      return;
    }
    const children = full.children ?? [];
    const eligible = children.filter((c) => typeSupportsQrCode(c.type));

    if (eligible.length === 0) {
      toast.warning(
        `No QR-eligible children found in ${location.name} (rooms/areas are excluded)`,
      );
      return;
    }

    const skipped = children.length - eligible.length;
    mergeCodes(eligible.map((c) => c.id));
    toast.success(
      `Added ${countLabel(eligible.length, "label")} from ${location.name}` +
        (skipped > 0 ? ` (skipped ${skipped} without QR support)` : ""),
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelected(null);
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm">
            <PlusIcon className="mr-2 size-4" />
            Add
          </Button>
        }
      />
      <PopoverContent
        align="start"
        aria-label="Add labels"
        className="w-[calc(100vw-1rem)] sm:w-96"
      >
        <Stack gap="sm">
          <EntityReferencePicker
            entity="location"
            label="Location"
            placeholder="Search locations..."
            openOnMount
            value={selected}
            setValue={setSelected}
          />
          {selected && (
            <Row gap="sm" justify="end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleAddChildren(selected)}
              >
                <UsersIcon className="size-4" />
                Add children
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleAddSingle(selected)}
              >
                Add {selected.name}
              </Button>
            </Row>
          )}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
