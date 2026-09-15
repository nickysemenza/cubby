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
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { entityMutation } from "~/entities/entity-mutation.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { getErrorMessage } from "~/lib/error-utils";

import {
  GARDEN_DIALOG_FORM_ID,
  GardenField,
  GardenFormActions,
  GardenNotes,
} from "./garden-fields";
import { GardenGuide } from "./garden-guide";
import {
  GardenPhotos,
  uploadGardenPhotos,
  type GardenPhotoDraft,
} from "./garden-photos";
import { GardenPicker } from "./garden-picker";
import { gardenStrings } from "./garden-strings";
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
  loadOptions,
}: {
  planting?: PlantingOut;
  location?: { id: string; name: string };
  onSaved: () => void;
  onCancel: () => void;
  loadOptions?: typeof garden.options;
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
  // Photo capture only applies to a NEW planting — an existing one manages its
  // gallery from the detail page's Photos section (`EntityPhotosSection`).
  const [photos, setPhotos] = useState<GardenPhotoDraft[]>([]);
  const isGrowing = status === "growing";
  // A new planting needs a crop always, and a current location only when it's
  // already growing (a planned one has no current location yet — just an
  // intended destination).
  const missingRequired = !resolvedCrop || (!planting && isGrowing && !place);
  // The form coordinates a source relationship and planting write; failures remain inline.
  const save = useMutation({
    meta: { invalidates: ripple.garden },
    mutationFn: async () => {
      const pendingImageIds = await uploadGardenPhotos(photos, undefined, () =>
        setPhotos([...photos]),
      );
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
        pendingImageIds,
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
      id={GARDEN_DIALOG_FORM_ID}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        save.mutate();
      }}
    >
      <Stack gap="lg">
        <GardenPicker
          entity="ingredient"
          label={gardenStrings.planting.cropField}
          required
          loadOptions={loadOptions}
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
            {gardenStrings.planting.rememberSourceLabel}
          </label>
        )}
        {!planting && (
          <Stack gap="sm">
            <Label htmlFor="planting-status">
              {gardenStrings.planting.stateField}
            </Label>
            <NativeSelect
              id="planting-status"
              value={status}
              onChange={(event) =>
                setStatus(
                  event.target.value === "planned" ? "planned" : "growing",
                )
              }
            >
              <option value="growing">
                {gardenStrings.planting.stateGrowing}
              </option>
              <option value="planned">
                {gardenStrings.planting.statePlanned}
              </option>
            </NativeSelect>
          </Stack>
        )}
        {!planting && isGrowing && (
          <GardenPicker
            entity="location"
            label={gardenStrings.planting.locationField}
            required
            value={place}
            onChange={setPlace}
            loadOptions={loadOptions}
          />
        )}
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {gardenStrings.planting.datesDetailsSummary}
          </summary>
          <Stack gap="md" className="pt-4">
            {!planting && isGrowing && (
              <Stack gap="sm">
                <GardenField
                  label={gardenStrings.planting.inLocationSinceField}
                  type="date"
                  value={inLocationSince}
                  onChange={setInLocationSince}
                />
                <p className="text-sm text-muted-foreground">
                  {gardenStrings.planting.inLocationSinceHelp}
                </p>
              </Stack>
            )}
            <GardenPicker
              entity="product"
              label={gardenStrings.planting.sourceField}
              loadOptions={loadOptions}
              value={
                sourceDetail.data
                  ? item(sourceDetail.data.id, sourceDetail.data.name)
                  : source
              }
              onChange={setSource}
            />
            <GardenPicker
              entity="location"
              label={gardenStrings.planting.intendedDestinationField}
              loadOptions={loadOptions}
              value={
                destinationDetail.data
                  ? item(destinationDetail.data.id, destinationDetail.data.name)
                  : destination
              }
              onChange={setDestination}
            />
            <GardenField
              label={gardenStrings.planting.varietyField}
              value={variety}
              onChange={setVariety}
            />
            <GardenField
              label={gardenStrings.planting.quantityField}
              value={quantity}
              onChange={setQuantity}
              placeholder={gardenStrings.planting.quantityPlaceholder}
            />
            <GardenField
              label={gardenStrings.planting.plannedWindowField}
              value={plannedWindow}
              onChange={setPlannedWindow}
              placeholder={gardenStrings.planting.plannedWindowPlaceholder}
            />
            <GardenField
              label={gardenStrings.planting.plannedDateField}
              type="date"
              value={plannedDate}
              onChange={setPlannedDate}
            />
            <GardenField
              label={gardenStrings.planting.sowedOnField}
              type="date"
              value={sowedOn}
              onChange={setSowedOn}
            />
            <GardenField
              label={gardenStrings.planting.transplantedOnField}
              type="date"
              value={transplantedOn}
              onChange={setTransplantedOn}
            />
            <p className="text-sm text-muted-foreground">
              {gardenStrings.planting.datesHelp}
            </p>
          </Stack>
        </details>
        <GardenNotes value={notes} onChange={setNotes} />
        {resolvedCrop && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {gardenStrings.planting.guideSummary}
            </summary>
            <Stack gap="md" className="pt-4">
              {guides.data && (
                <Stack gap="sm">
                  <Label htmlFor="garden-guide-key">
                    {gardenStrings.planting.guideFieldLabel}
                  </Label>
                  <NativeSelect
                    id="garden-guide-key"
                    value={guideKey}
                    onChange={(event) => setGuideSelection(event.target.value)}
                  >
                    <option value="">
                      {gardenStrings.planting.guideNoneOption}
                    </option>
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
        {!planting && (
          <GardenPhotos
            photos={photos}
            onChange={setPhotos}
            disabled={save.isPending}
            description={gardenStrings.photos.plantingHelp}
          />
        )}
        <GardenFormActions
          pending={save.isPending}
          error={error}
          onCancel={onCancel}
          disabled={missingRequired}
          label={
            planting
              ? gardenStrings.common.saveLabel
              : gardenStrings.planting.submitAdd
          }
        />
      </Stack>
    </form>
  );
}
