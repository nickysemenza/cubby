import type { ProposedItem } from "@cubby/schemas/capture";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import {
  getLocationId,
  getProductId,
  inventoryItemWithLocationFields,
} from "~/app/_components/form-fields";
import { ComboboxFieldWithSearch } from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { useTRPC } from "~/trpc/react";

const confidenceVariant = {
  high: "secondary",
  medium: "outline",
  low: "outline",
} as const;

const itemFormSchema = inventoryItemWithLocationFields;
type ItemFormValues = z.input<typeof itemFormSchema>;

/** One proposed item from a shelf scan: an inline form to add it to inventory. */
export function CaptureItemCard({ proposal }: { proposal: ProposedItem }) {
  const api = useTRPC();
  const [added, setAdded] = useState(false);

  const form = useForm<ItemFormValues>({
    resolver: zodResolver(itemFormSchema),
    defaultValues: {
      product: undefined,
      location: undefined,
      amount: { value: proposal.quantity, unit: proposal.unit },
    },
  });

  const create = useMutation(
    api.inventory.create.mutationOptions({
      onSuccess: () => {
        toast.success(`Tucked ${proposal.name} into your cubby.`);
        setAdded(true);
      },
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );

  const onSubmit = (values: ItemFormValues) => {
    create.mutate({
      productId: getProductId(values.product),
      locationId: getLocationId(values.location),
      amount: values.amount,
    });
  };

  const meta = [
    isUnspecifiedManufacturer(proposal.manufacturer)
      ? null
      : proposal.manufacturer,
    `${proposal.quantity} ${proposal.unit}`,
  ]
    .filter(Boolean)
    .join(" · ");

  if (added) {
    return (
      <Row
        align="center"
        gap="sm"
        className="rounded-md border border-border/50 px-2 py-2 text-muted-foreground text-sm"
      >
        <Check className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate">Added {proposal.name} to inventory</span>
      </Row>
    );
  }

  return (
    <Stack
      as="form"
      gap="sm"
      onSubmit={form.handleSubmit(onSubmit)}
      className="rounded-lg border border-border/50 p-2"
    >
      <Row align="center" justify="between" gap="sm">
        <div className="min-w-0">
          <span className="font-medium text-sm">{proposal.name}</span>
          {meta && (
            <Description as="span" size="xs" className="ml-2">
              {meta}
            </Description>
          )}
        </div>
        <Badge variant={confidenceVariant[proposal.confidence]}>
          {proposal.confidence}
        </Badge>
      </Row>

      <Row align="end" wrap gap="sm">
        <div className="min-w-[8rem] flex-[3]">
          <ComboboxFieldWithSearch
            form={form}
            name="product"
            label="Product"
            searchType="product"
          />
        </div>
        <div className="min-w-[8rem] flex-[3]">
          <ComboboxFieldWithSearch
            form={form}
            name="location"
            label="Location"
            searchType="location"
          />
        </div>
        <div className="min-w-[7rem] flex-[2]">
          <AmountFieldGroup
            form={form}
            valuePath="amount.value"
            unitPath="amount.unit"
            compact
          />
        </div>
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? <Spinner className="mr-1" /> : null}
          Add
        </Button>
      </Row>
    </Stack>
  );
}
