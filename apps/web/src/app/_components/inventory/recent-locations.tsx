import type { LocationOut } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row, Stack } from "~/components/layout";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/trpc/react";

interface RecentLocationsProps {
  onSelect: (location: LocationOut) => void;
}

export function RecentLocations({ onSelect }: RecentLocationsProps) {
  const api = useTRPC();

  const { data: recentLocations, isLoading } = useQuery(
    api.location.getRecentlyActive.queryOptions({ limit: 5 }),
  );

  if (isLoading) {
    return (
      <Row align="center" justify="center" className="py-4">
        <Spinner />
      </Row>
    );
  }

  if (!recentLocations || recentLocations.length === 0) {
    return null;
  }

  return (
    <Stack gap="sm">
      <Row align="center" gap="sm" className="text-muted-foreground text-xs">
        <MapPin className="h-3 w-3" />
        <span>Recent locations</span>
      </Row>
      <Row gap="sm" wrap>
        {recentLocations.map((location) => (
          <button
            key={location.id}
            type="button"
            onClick={() => onSelect(location)}
            className="flex items-center gap-2 rounded-full border bg-background px-2 py-2 text-sm transition-colors hover:border-primary hover:bg-primary/5"
          >
            <LocationIcon
              type={location.type}
              size={14}
              className="text-muted-foreground"
            />
            <span className="max-w-[150px] truncate">{location.name}</span>
          </button>
        ))}
      </Row>
    </Stack>
  );
}
