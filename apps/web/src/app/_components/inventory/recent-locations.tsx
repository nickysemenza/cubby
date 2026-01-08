import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Spinner } from "~/components/ui/spinner";
import type { LocationOut } from "~/schemas/location";
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
      <div className="flex items-center justify-center py-4">
        <Spinner />
      </div>
    );
  }

  if (!recentLocations || recentLocations.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <MapPin className="h-3 w-3" />
        <span>Recent locations</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {recentLocations.map((location) => (
          <button
            key={location.id}
            type="button"
            onClick={() => onSelect(location)}
            className="flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-sm transition-colors hover:border-primary hover:bg-primary/5"
          >
            <LocationIcon
              type={location.type}
              size={14}
              className="text-muted-foreground"
            />
            <span className="max-w-[150px] truncate">{location.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
