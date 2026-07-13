import type { LocationId } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import { extractShortcodeFromScan } from "@cubby/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, CircleAlert, CircleHelp, MapPin } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { buildLocationComboboxItem } from "~/app/_components/combobox/combobox-builders";
import { optionalLocationField } from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import {
  PersistentScanner,
  QR_CODE_FORMATS,
} from "~/app/_components/inventory/persistent-scanner";
import { LocationTypeLabel } from "~/app/_components/locations/LocationTypeLabel";
import { LocationBreadcrumb } from "~/app/_components/locations/location-breadcrumb";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { typeSupportsQrCode } from "~/app/_components/locations/location-type-theme";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateTRPCQueries, queryKeys } from "~/lib/query-keys";

type Phase = "SELECT_LOCATION" | "SCANNING" | "RECONCILIATION";

interface ScannedLocation {
  shortcode: string;
  location: InfLocation;
}

// Form schema for location picker
const locationPickerSchema = z.object({
  parentLocation: optionalLocationField,
});
type LocationPickerValues = z.infer<typeof locationPickerSchema>;

// Inline reassignment form schema
const reassignSchema = z.object({
  newParent: optionalLocationField,
});
type ReassignValues = z.infer<typeof reassignSchema>;

interface LocationValidateFormProps {
  initialParentId?: string;
}

export function LocationValidateForm({
  initialParentId,
}: LocationValidateFormProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<Phase>("SELECT_LOCATION");
  const [parentLocationId, setParentLocationId] = useState<string | null>(
    initialParentId ?? null,
  );
  const [scannedLocations, setScannedLocations] = useState<
    Map<string, ScannedLocation>
  >(new Map());

  // Fetch parent location with children
  const { data: parentLocation } = useQuery({
    ...api.location.getByID.queryOptions({
      id: parentLocationId!,
    }),
    enabled: !!parentLocationId,
  });

  // Set up form for location picker
  const form = useForm<LocationPickerValues>({
    resolver: zodResolver(locationPickerSchema),
    defaultValues: { parentLocation: null },
  });

  // Pre-fill combobox when parent location loads from URL param
  const watchedLocation = form.watch("parentLocation");
  if (
    parentLocation &&
    initialParentId &&
    !watchedLocation &&
    parentLocationId === initialParentId
  ) {
    form.setValue("parentLocation", buildLocationComboboxItem(parentLocation));
  }

  // Watch for combobox changes
  const selectedLocation = form.watch("parentLocation");
  if (selectedLocation && selectedLocation.id !== parentLocationId) {
    setParentLocationId(selectedLocation.id);
  }

  // Only include children that have QR labels (excludes spaces like room/area)
  const children = useMemo(
    () =>
      (parentLocation?.children ?? []).filter((c) =>
        typeSupportsQrCode(c.type),
      ),
    [parentLocation?.children],
  );
  const childCount = children.length;

  // Handle QR scan
  const handleScan = useCallback(
    async (rawValue: string) => {
      const parsed = extractShortcodeFromScan(rawValue);
      if (!parsed) {
        toast.error("Not a valid QR code");
        return;
      }

      if (parsed.type !== "location") {
        toast.error("Not a location QR code");
        return;
      }

      const shortcode = parsed.shortcode;

      // Skip if this is the parent location itself
      if (parentLocation?.shortcode === shortcode) {
        toast.info("That's the parent location itself");
        return;
      }

      // Skip if already scanned
      if (scannedLocations.has(shortcode)) {
        toast.info("Already scanned");
        return;
      }

      // Resolve the shortcode to a location
      try {
        const location = await queryClient.fetchQuery(
          api.location.getByShortcode.queryOptions({ shortcode }),
        );
        if (!location) {
          toast.error(`No location found for ${shortcode}`);
          return;
        }

        setScannedLocations((prev) => {
          const next = new Map(prev);
          next.set(shortcode, { shortcode, location });
          return next;
        });
        toast.success(`Scanned: ${location.name}`);
      } catch (err) {
        toast.error(`Failed to look up ${shortcode}: ${getErrorMessage(err)}`);
      }
    },
    [parentLocation, scannedLocations, queryClient, api],
  );

  // Reconciliation data
  const childShortcodes = useMemo(
    () => new Set(children.map((c) => c.shortcode as string)),
    [children],
  );

  const confirmed = useMemo(
    () => children.filter((c) => scannedLocations.has(c.shortcode as string)),
    [children, scannedLocations],
  );

  const missing = useMemo(
    () => children.filter((c) => !scannedLocations.has(c.shortcode as string)),
    [children, scannedLocations],
  );

  const unexpected = useMemo(
    () =>
      Array.from(scannedLocations.values()).filter(
        (s) => !childShortcodes.has(s.shortcode),
      ),
    [scannedLocations, childShortcodes],
  );

  const scannedCount = Array.from(scannedLocations.values()).filter((s) =>
    childShortcodes.has(s.shortcode),
  ).length;

  // Update mutation for reassignment
  const updateMutation = useMutation(
    api.location.update.mutationOptions({
      onSuccess: () => {
        // Reparenting changes tree shape (location.makeTree) and valuation
        // rollups, so invalidate the broad location.all prefix (subsumes list +
        // makeTree + getByID) rather than just location.list.
        invalidateTRPCQueries(queryClient, [queryKeys.location.all]);
      },
    }),
  );

  const handleConfirmHere = useCallback(
    async (locationId: LocationId) => {
      if (!parentLocationId) return;
      try {
        await updateMutation.mutateAsync({
          id: locationId,
          data: { parentId: parentLocationId },
        });
        toast.success("Location reassigned");
      } catch (err) {
        toast.error(`Failed to reassign: ${getErrorMessage(err)}`);
      }
    },
    [parentLocationId, updateMutation],
  );

  const handleReassign = useCallback(
    async (locationId: LocationId, newParentId: string) => {
      try {
        await updateMutation.mutateAsync({
          id: locationId,
          data: { parentId: newParentId },
        });
        toast.success("Location reassigned");
      } catch (err) {
        toast.error(`Failed to reassign: ${getErrorMessage(err)}`);
      }
    },
    [updateMutation],
  );

  const handleStartOver = useCallback(() => {
    setPhase("SELECT_LOCATION");
    setParentLocationId(null);
    setScannedLocations(new Map());
    form.reset();
  }, [form]);

  // Phase 1: SELECT_LOCATION
  if (phase === "SELECT_LOCATION") {
    return (
      <div className="space-y-2">
        <ComboboxFieldWithSearch
          form={form}
          name="parentLocation"
          label="Parent Location"
          searchType="location"
        />

        {parentLocation && (
          <div className="space-y-2">
            <LocationBreadcrumb location={parentLocation} linkable />
            <Description>
              {childCount} child location{childCount !== 1 ? "s" : ""} to
              validate
            </Description>
            {children.length > 0 && (
              <div className="space-y-1">
                {children.map((child) => (
                  <div
                    key={child.id}
                    className="flex items-center gap-2 text-muted-foreground text-sm"
                  >
                    <LocationIcon type={child.type} size={14} />
                    <span>{child.name}</span>
                    <span className="text-xs opacity-60">
                      {child.shortcode}
                    </span>
                    <LocationTypeLabel type={child.type} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <Button
          onClick={() => setPhase("SCANNING")}
          disabled={!parentLocationId || childCount === 0}
        >
          Start Scanning
        </Button>
      </div>
    );
  }

  // Phase 2: SCANNING
  if (phase === "SCANNING") {
    return (
      <div className="space-y-2">
        {parentLocation && (
          <LocationBreadcrumb location={parentLocation} linkable />
        )}

        <Description>
          Scanned {scannedCount} of {childCount} expected
        </Description>

        <PersistentScanner
          onScan={handleScan}
          formatsToSupport={QR_CODE_FORMATS}
          scanHintText="Point at location QR code"
        />

        {/* Expected children checklist */}
        <div className="space-y-2">
          <h4 className="font-medium text-sm">
            Expected ({scannedCount} of {childCount} confirmed)
          </h4>
          <div className="space-y-1">
            {children.map((child) => {
              const isScanned = scannedLocations.has(child.shortcode as string);
              return (
                <div
                  key={child.id}
                  className={`flex items-center gap-2 text-sm ${
                    isScanned ? "text-positive" : "text-muted-foreground"
                  }`}
                >
                  {isScanned ? (
                    <Check className="h-4 w-4 shrink-0 text-positive" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 opacity-40" />
                  )}
                  <LocationIcon type={child.type} size={14} />
                  <span>{child.name}</span>
                  <span className="text-xs opacity-60">{child.shortcode}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Unexpected scans */}
        {unexpected.length > 0 && (
          <div className="space-y-2">
            <h4 className="font-medium text-primary text-sm">
              Unexpected ({unexpected.length})
            </h4>
            <div className="space-y-1">
              {unexpected.map((item) => (
                <div
                  key={item.shortcode}
                  className="flex items-center gap-2 text-primary text-sm"
                >
                  <CircleHelp className="h-4 w-4 shrink-0" />
                  <LocationIcon type={item.location.type} size={14} />
                  <span>{item.location.name}</span>
                  <span className="text-xs opacity-60">{item.shortcode}</span>
                  {item.location.parent && (
                    <span className="text-muted-foreground text-xs">
                      (in {item.location.parent.name})
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <Button onClick={() => setPhase("RECONCILIATION")}>
          Done Scanning
        </Button>
      </div>
    );
  }

  // Phase 3: RECONCILIATION
  return (
    <div className="space-y-2">
      {parentLocation && (
        <LocationBreadcrumb location={parentLocation} linkable />
      )}

      <Description>
        {confirmed.length} confirmed, {missing.length} missing,{" "}
        {unexpected.length} unexpected
      </Description>

      {/* Confirmed */}
      {confirmed.length > 0 && (
        <Card className="border-positive/20">
          <CardHeader className="pb-2">
            <CardTitle>
              <Check className="h-4 w-4 text-positive" />
              Confirmed ({confirmed.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {confirmed.map((child) => (
                <div key={child.id} className="flex items-center gap-2 text-sm">
                  <LocationIcon type={child.type} size={14} />
                  <span>{child.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {child.shortcode}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Missing */}
      {missing.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader className="pb-2">
            <CardTitle>
              <CircleAlert className="h-4 w-4 text-warning" />
              Missing ({missing.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {missing.map((child) => (
                <MissingLocationRow
                  key={child.id}
                  location={child}
                  onReassign={handleReassign}
                  isPending={updateMutation.isPending}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Unexpected */}
      {unexpected.length > 0 && (
        <Card className="border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle>
              <CircleHelp className="h-4 w-4 text-primary" />
              Unexpected ({unexpected.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {unexpected.map((item) => (
                <div
                  key={item.shortcode}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <LocationIcon type={item.location.type} size={14} />
                    <span>{item.location.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {item.shortcode}
                    </span>
                    {item.location.parent && (
                      <span className="text-muted-foreground text-xs">
                        (currently in {item.location.parent.name})
                      </span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleConfirmHere(item.location.id)}
                    disabled={updateMutation.isPending}
                  >
                    <MapPin className="mr-1 h-3 w-3" />
                    Confirm Here
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Footer actions */}
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setPhase("SCANNING")}>
          Scan More
        </Button>
        <Button variant="ghost" onClick={handleStartOver}>
          Start Over
        </Button>
      </div>
    </div>
  );
}

// Sub-component for missing location rows with inline reassignment
function MissingLocationRow({
  location,
  onReassign,
  isPending,
}: {
  location: InfLocation;
  onReassign: (locationId: LocationId, newParentId: string) => Promise<void>;
  isPending: boolean;
}) {
  const [showReassign, setShowReassign] = useState(false);

  const form = useForm<ReassignValues>({
    resolver: zodResolver(reassignSchema),
    defaultValues: { newParent: null },
  });

  const handleReassign = useCallback(async () => {
    const selected = form.getValues("newParent");
    if (!selected) return;
    await onReassign(location.id, selected.id);
    setShowReassign(false);
  }, [form, location.id, onReassign]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          <LocationIcon type={location.type} size={14} />
          <span>{location.name}</span>
          <span className="text-muted-foreground text-xs">
            {location.shortcode}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowReassign(!showReassign)}
        >
          Reassign to...
        </Button>
      </div>
      {showReassign && (
        <div className="flex items-end gap-2 pl-6">
          <div className="flex-1">
            <ComboboxFieldWithSearch
              form={form}
              name="newParent"
              label="New parent"
              searchType="location"
            />
          </div>
          <Button
            size="sm"
            onClick={handleReassign}
            disabled={!form.watch("newParent") || isPending}
          >
            Move
          </Button>
        </div>
      )}
    </div>
  );
}
