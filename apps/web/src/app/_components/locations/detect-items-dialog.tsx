import type { DetectedItem } from "@cubby/schemas/ai";
import type { LocationId } from "@cubby/schemas/identifiers";
import { useMutation } from "@tanstack/react-query";
import { Package, Sparkles, Trash2 } from "lucide-react";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCreateInventoryMutation } from "~/app/_components/inventory/hooks";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { useTRPC } from "~/trpc/react";

interface DetectItemsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: LocationId;
  locationName: string;
}

const confidenceVariant = {
  high: "default",
  medium: "secondary",
  low: "outline",
} as const;

export const DetectItemsDialog: FC<DetectItemsDialogProps> = ({
  open,
  onOpenChange,
  locationId,
  locationName,
}) => {
  const api = useTRPC();
  const [items, setItems] = useState<DetectedItem[]>([]);
  const [summary, setSummary] = useState<string>("");

  const detectMutation = useMutation(
    api.ai.detectInventoryItems.mutationOptions({
      onSuccess: (data) => {
        setItems(data.items);
        setSummary(data.summary);
      },
      onError: (error) => {
        toast.error(getErrorMessage(error));
      },
    }),
  );

  const createMutation = useCreateInventoryMutation({
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });

  // Use ref to avoid re-triggering effect when mutation reference changes
  const detectRef = useRef(detectMutation.mutate);
  detectRef.current = detectMutation.mutate;

  // Trigger detection when dialog opens
  useEffect(() => {
    if (open) {
      setItems([]);
      setSummary("");
      detectRef.current({ locationId });
    }
  }, [open, locationId]);

  const dismissItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAddItems = useCallback(async () => {
    if (items.length === 0) return;

    let added = 0;
    for (const item of items) {
      try {
        // Create as misc product with detected quantity
        await createMutation.mutateAsync({
          productId: undefined as never, // Will be handled by quick-add flow
          locationId,
          amount: { value: item.estimatedQuantity, unit: item.unit },
        });
        added++;
      } catch {
        // Individual failures are already toasted by onError
      }
    }

    if (added > 0) {
      toast.success(
        `Added ${added} item${added === 1 ? "" : "s"} to inventory`,
      );
      onOpenChange(false);
    }
  }, [items, locationId, createMutation, onOpenChange]);

  const isLoading = detectMutation.isPending;
  const hasResults = items.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Detect Items
          </DialogTitle>
          <DialogDescription>
            Analyzing photos of "{locationName}" to identify inventory items
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex flex-col items-center gap-2 py-6">
            <Spinner className="h-6 w-6" />
            <Description>Analyzing photos...</Description>
          </div>
        )}

        {!isLoading && !hasResults && detectMutation.isSuccess && (
          <div className="py-6 text-center">
            <Package className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <Description>No items detected in the photos</Description>
          </div>
        )}

        {!isLoading && hasResults && (
          <>
            {summary && <Description>{summary}</Description>}
            <ScrollArea className="max-h-[400px]">
              <Stack gap="sm">
                {items.map((item, index) => (
                  <Row
                    key={`${item.name}-${index}`}
                    align="center"
                    gap="sm"
                    className="rounded-md border border-[var(--border)] p-4"
                  >
                    <div className="min-w-0 flex-1">
                      <Row align="center" gap="sm">
                        <span className="truncate font-medium text-sm">
                          {item.name}
                        </span>
                        <Badge variant={confidenceVariant[item.confidence]}>
                          {item.confidence}
                        </Badge>
                      </Row>
                      <Description>
                        {!isUnspecifiedManufacturer(item.manufacturer) && (
                          <span>{item.manufacturer} &middot; </span>
                        )}
                        {item.estimatedQuantity} {item.unit}
                      </Description>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => dismissItem(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </Row>
                ))}
              </Stack>
            </ScrollArea>
          </>
        )}

        {!isLoading && hasResults && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddItems}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <Spinner className="mr-2" />
              ) : (
                <Package className="mr-2 h-4 w-4" />
              )}
              Add {items.length} Item{items.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
