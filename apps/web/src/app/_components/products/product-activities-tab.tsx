import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Clock, Plus } from "lucide-react";
import { type FC, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { queryKeys } from "~/lib/query-keys";
import type { ProductId } from "~/schemas/identifiers";
import { useTRPC } from "~/trpc/react";
import type { PendingImage } from "../PendingImageUpload";
import { PendingImageUpload } from "../PendingImageUpload";

interface ProductActivitiesTabProps {
  productId: ProductId;
}

export const ProductActivitiesTab: FC<ProductActivitiesTabProps> = ({
  productId,
}) => {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [activityName, setActivityName] = useState("");
  const [notes, setNotes] = useState("");
  const [intervalDays, setIntervalDays] = useState<string>("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  const { data: activityTypes, isLoading } = useQuery(
    api.activityType.listByProduct.queryOptions({ productId }),
  );

  const findOrCreateMutation = useMutation(
    api.activityType.findOrCreate.mutationOptions(),
  );

  const createEntryMutation = useMutation(
    api.activityEntry.create.mutationOptions(),
  );

  const handleLogActivity = async () => {
    if (!activityName.trim()) return;

    // Find or create activity type
    const activityType = await findOrCreateMutation.mutateAsync({
      productId,
      name: activityName.trim(),
      intervalDays: intervalDays ? Number.parseInt(intervalDays, 10) : null,
    });

    // Create entry
    await createEntryMutation.mutateAsync({
      activityTypeId: activityType.id as never,
      notes: notes.trim() || null,
      imageIds:
        pendingImages.length > 0
          ? pendingImages.map((img) => img.id)
          : undefined,
    });

    // Invalidate queries
    await queryClient.invalidateQueries({
      queryKey: queryKeys.activityType.byProduct,
    });

    // Reset form
    setActivityName("");
    setNotes("");
    setIntervalDays("");
    setPendingImages([]);
    setIsDialogOpen(false);
  };

  if (isLoading) {
    return <div className="p-4">Loading activities...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-lg">Activities</h3>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Log Activity
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log Activity</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="activityName">Activity Name</Label>
                <Input
                  id="activityName"
                  value={activityName}
                  onChange={(e) => setActivityName(e.target.value)}
                  placeholder="e.g., Oil Change, Descale"
                />
              </div>
              <div>
                <Label htmlFor="notes">Notes (optional)</Label>
                <Textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any notes about this activity"
                />
              </div>
              <div>
                <Label htmlFor="intervalDays">
                  Repeat every (days, optional)
                </Label>
                <Input
                  id="intervalDays"
                  type="number"
                  value={intervalDays}
                  onChange={(e) => setIntervalDays(e.target.value)}
                  placeholder="e.g., 90"
                />
              </div>
              <PendingImageUpload
                entityType="PRODUCT"
                onImagesChange={setPendingImages}
              />
              <Button
                onClick={handleLogActivity}
                disabled={
                  !activityName.trim() ||
                  findOrCreateMutation.isPending ||
                  createEntryMutation.isPending
                }
              >
                {findOrCreateMutation.isPending || createEntryMutation.isPending
                  ? "Saving..."
                  : "Log Activity"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {activityTypes && activityTypes.length > 0 ? (
        <div className="space-y-2">
          {activityTypes.map((activity) => (
            <div
              key={activity.id}
              className="flex items-center justify-between rounded-lg border p-3"
            >
              <div>
                <div className="font-medium">{activity.name}</div>
                <div className="text-muted-foreground text-sm">
                  {activity.lastCompletedAt ? (
                    <>
                      Last:{" "}
                      {formatDistanceToNow(activity.lastCompletedAt, {
                        addSuffix: true,
                      })}
                    </>
                  ) : (
                    "Never completed"
                  )}
                  {activity.intervalDays && (
                    <span className="ml-2">
                      <Clock className="inline h-3 w-3" /> Every{" "}
                      {activity.intervalDays} days
                    </span>
                  )}
                </div>
              </div>
              {activity.isOverdue && (
                <Badge variant="destructive">Overdue</Badge>
              )}
              {activity.isDueSoon && !activity.isOverdue && (
                <Badge variant="outline">Due soon</Badge>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="py-8 text-center text-muted-foreground">
          No activities logged yet. Click "Log Activity" to add one.
        </div>
      )}
    </div>
  );
};
