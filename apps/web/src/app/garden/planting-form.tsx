import {
  gardenCreatePlantingInput,
  plantingUpdateData,
  type PlantingOut,
} from "@cubby/schemas/garden";
import {
  ingredientShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { Stack } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";

import { GardenField, GardenFormActions, GardenNotes } from "./garden-fields";
import { GardenGuide } from "./garden-guide";
import { GardenPicker } from "./garden-picker";
import { garden } from "./garden.functions";

const nullable = (text: string) => text.trim() || null;
const item = (
  id: string | null | undefined,
  name?: string,
): ComboboxItem | null => (id ? { id, name: name ?? id } : null);

function usePlantingInputs(
  planting: PlantingOut | undefined,
  location: { id: string; name: string } | undefined,
) {
  const [source, setSource] = useState<ComboboxItem | null>(() =>
    item(planting?.sourceProductId),
  );
  const [crop, setCrop] = useState<ComboboxItem | null>(() =>
    item(planting?.ingredientId),
  );
  const [place, setPlace] = useState<ComboboxItem | null>(() =>
    item(planting?.locationId ?? location?.id, location?.name),
  );
  const [destination, setDestination] = useState<ComboboxItem | null>(() =>
    item(planting?.intendedLocationId),
  );
  const [status, setStatus] = useState(planting?.status ?? "growing");
  const [variety, setVariety] = useState(planting?.variety ?? "");
  const [quantity, setQuantity] = useState(planting?.quantity ?? "");
  const [notes, setNotes] = useState(planting?.notes ?? "");
  const [plannedWindow, setPlannedWindow] = useState(
    planting?.plannedWindow ?? "",
  );
  const [plannedDate, setPlannedDate] = useState(planting?.plannedDate ?? "");
  const [sowedOn, setSowedOn] = useState(planting?.sowedOn ?? "");
  const [transplantedOn, setTransplantedOn] = useState(
    planting?.transplantedOn ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [rememberSource, setRememberSource] = useState(true);
  const [guideSelection, setGuideSelection] = useState<string | undefined>();
  return {
    source,
    setSource,
    crop,
    setCrop,
    place,
    setPlace,
    destination,
    setDestination,
    status,
    setStatus,
    variety,
    setVariety,
    quantity,
    setQuantity,
    notes,
    setNotes,
    plannedWindow,
    setPlannedWindow,
    plannedDate,
    setPlannedDate,
    sowedOn,
    setSowedOn,
    transplantedOn,
    setTransplantedOn,
    error,
    setError,
    rememberSource,
    setRememberSource,
    guideSelection,
    setGuideSelection,
  };
}

function usePlantingReferences(
  source: ComboboxItem | null,
  crop: ComboboxItem | null,
  destination: ComboboxItem | null,
  guideSelection: string | undefined,
) {
  const sourceDetail = useQuery(
    entityDetailFor("product").queryOptions(source?.id ?? "", {
      enabled: Boolean(source),
    }),
  );
  const suggestedCropId = sourceDetail.data?.growsIngredientId;
  const suggestedCrop = useQuery(
    entityDetailFor("ingredient").queryOptions(suggestedCropId ?? "", {
      enabled: Boolean(suggestedCropId),
    }),
  );
  const resolvedCrop =
    crop ??
    (suggestedCrop.data
      ? item(suggestedCrop.data.id, suggestedCrop.data.name)
      : null);
  const cropDetail = useQuery(
    entityDetailFor("ingredient").queryOptions(resolvedCrop?.id ?? "", {
      enabled: Boolean(resolvedCrop),
    }),
  );
  const guides = useQuery(garden.guides.queryOptions(undefined));
  const destinationDetail = useQuery(
    entityDetailFor("location").queryOptions(destination?.id ?? "", {
      enabled: Boolean(destination),
    }),
  );
  const guideKey = guideSelection ?? cropDetail.data?.gardenGuideKey ?? "";
  return {
    sourceDetail,
    resolvedCrop,
    cropDetail,
    guides,
    destinationDetail,
    guideKey,
  };
}

export function PlantingForm({
  planting,
  location,
  onSaved,
  onCancel,
}: {
  planting?: PlantingOut;
  location?: { id: string; name: string };
  onSaved: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [inLocationSince, setInLocationSince] = useState("");
  const {
    source,
    setSource,
    crop,
    setCrop,
    place,
    setPlace,
    destination,
    setDestination,
    status,
    setStatus,
    variety,
    setVariety,
    quantity,
    setQuantity,
    notes,
    setNotes,
    plannedWindow,
    setPlannedWindow,
    plannedDate,
    setPlannedDate,
    sowedOn,
    setSowedOn,
    transplantedOn,
    setTransplantedOn,
    error,
    setError,
    rememberSource,
    setRememberSource,
    guideSelection,
    setGuideSelection,
  } = usePlantingInputs(planting, location);
  const {
    sourceDetail,
    resolvedCrop,
    cropDetail,
    guides,
    destinationDetail,
    guideKey,
  } = usePlantingReferences(source, crop, destination, guideSelection);
  // The form coordinates a source relationship and planting write; failures remain inline.
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const data = gardenCreatePlantingInput.parse({
        ingredientId: resolvedCrop?.id,
        sourceProductId: source?.id ?? null,
        locationId: place?.id ?? null,
        intendedLocationId: destination?.id ?? null,
        status,
        variety: nullable(variety),
        quantity: nullable(quantity),
        notes: nullable(notes),
        plannedWindow: nullable(plannedWindow),
        plannedDate: nullable(plannedDate),
        sowedOn: nullable(sowedOn),
        transplantedOn: nullable(transplantedOn),
        inLocationSince:
          !planting && status === "growing"
            ? (nullable(inLocationSince) ?? undefined)
            : undefined,
      });
      if (source && rememberSource) {
        const currentSource = await queryClient.ensureQueryData(
          entityDetailFor("product").queryOptions(source.id),
        );
        if (!currentSource)
          throw new Error("The source product is no longer available.");
        if (currentSource.growsIngredientId !== data.ingredientId)
          await entityMutation.mutate.call({
            entity: "product",
            action: "update",
            id: productShortcode.parse(source.id),
            data: { growsIngredientId: data.ingredientId },
          });
      }
      if (guideSelection !== undefined && resolvedCrop)
        await entityMutation.mutate.call({
          entity: "ingredient",
          action: "update",
          id: ingredientShortcode.parse(resolvedCrop.id),
          data: { gardenGuideKey: guideSelection || null },
        });
      if (planting) {
        await entityMutation.mutate.call({
          entity: "planting",
          action: "update",
          id: planting.id,
          data: plantingUpdateData.parse({
            ...data,
            locationId: undefined,
            status: undefined,
          }),
        });
      } else {
        await garden.createPlanting.call(data);
      }
    },
    onSuccess: onSaved,
    onError: (error) => setError(getErrorMessage(error)),
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <Stack gap="lg">
        <GardenPicker
          entity="ingredient"
          label="Crop"
          value={
            cropDetail.data
              ? item(cropDetail.data.id, cropDetail.data.name)
              : resolvedCrop
          }
          onChange={(value) => {
            setCrop(value);
            setGuideSelection(undefined);
          }}
        />
        {source && resolvedCrop && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rememberSource}
              onChange={(event) => setRememberSource(event.target.checked)}
            />
            Remember that this product grows this crop
          </label>
        )}
        {!planting && (
          <GardenPicker
            entity="location"
            label="Growing location"
            value={place}
            onChange={setPlace}
          />
        )}
        {!planting && (
          <Stack gap="sm">
            <label htmlFor="planting-status">Planting state</label>
            <NativeSelect
              id="planting-status"
              value={status}
              onChange={(event) =>
                setStatus(
                  event.target.value === "planned" ? "planned" : "growing",
                )
              }
            >
              <option value="growing">Already growing</option>
              <option value="planned">Plan for later</option>
            </NativeSelect>
          </Stack>
        )}
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Dates and other details (optional)
          </summary>
          <Stack gap="md" className="pt-4">
            {!planting && status === "growing" && (
              <Stack gap="sm">
                <GardenField
                  label="In this location since"
                  type="date"
                  value={inLocationSince}
                  onChange={setInLocationSince}
                />
                <p className="text-sm text-muted-foreground">
                  Optional. This confirms which older bed photos belong in the
                  journal. Leave blank to record presence from today without
                  guessing an earlier date.
                </p>
              </Stack>
            )}
            <GardenPicker
              entity="product"
              label="Seed packet or plant (optional)"
              value={
                sourceDetail.data
                  ? item(sourceDetail.data.id, sourceDetail.data.name)
                  : source
              }
              onChange={setSource}
            />
            <GardenPicker
              entity="location"
              label="Intended destination"
              value={
                destinationDetail.data
                  ? item(destinationDetail.data.id, destinationDetail.data.name)
                  : destination
              }
              onChange={setDestination}
            />
            <GardenField
              label="Variety"
              value={variety}
              onChange={setVariety}
            />
            <GardenField
              label="Approximate quantity"
              value={quantity}
              onChange={setQuantity}
              placeholder="A few seedlings"
            />
            <GardenField
              label="Planned window"
              value={plannedWindow}
              onChange={setPlannedWindow}
              placeholder="Early autumn"
            />
            <GardenField
              label="Planned date"
              type="date"
              value={plannedDate}
              onChange={setPlannedDate}
            />
            <GardenField
              label="Sowed on"
              type="date"
              value={sowedOn}
              onChange={setSowedOn}
            />
            <GardenField
              label="Transplanted on"
              type="date"
              value={transplantedOn}
              onChange={setTransplantedOn}
            />
            <p className="text-sm text-muted-foreground">
              Leave dates blank when you don’t know them.
            </p>
          </Stack>
        </details>
        <GardenNotes value={notes} onChange={setNotes} />
        {resolvedCrop && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Local planting guide
            </summary>
            <Stack gap="md" className="pt-4">
              {guides.data && (
                <Stack gap="sm">
                  <label htmlFor="garden-guide-key">
                    Guide for this ingredient
                  </label>
                  <NativeSelect
                    id="garden-guide-key"
                    value={guideKey}
                    onChange={(event) => setGuideSelection(event.target.value)}
                  >
                    <option value="">No guide linked</option>
                    {guides.data.guides.map((guide) => (
                      <option key={guide.key} value={guide.key}>
                        {guide.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Stack>
              )}
              <GardenGuide guideKey={guideKey} />
            </Stack>
          </details>
        )}
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
          label={planting ? "Save changes" : "Add planting"}
        />
      </Stack>
    </form>
  );
}
