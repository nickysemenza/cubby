import type { WishOut } from "@cubby/schemas/wish";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useTRPC } from "~/integrations/trpc/react";
import { wishMutationInvalidateKeys } from "~/lib/query-keys";

type WishFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wish?: WishOut;
  onSaved?: (wish: WishOut) => void;
};

/** The compact MVP editor: a wish describes the outcome, with optional Tool alternatives. */
export function WishFormDialog({
  open,
  onOpenChange,
  wish,
  onSaved,
}: WishFormDialogProps) {
  const api = useTRPC();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const idPrefix = useId();
  const nameInputId = `${idPrefix}-name`;
  const notesInputId = `${idPrefix}-notes`;
  const productSearchInputId = `${idPrefix}-product-search`;
  const productsQuery = useQuery(
    api.product.list.queryOptions({
      filters: { categoryFilter: "tools" },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
  );

  useEffect(() => {
    if (!open) return;
    setName(wish?.name ?? "");
    setNotes(wish?.notes ?? "");
    setCandidateIds(wish?.candidates.map((candidate) => candidate.id) ?? []);
    setProductSearch("");
  }, [open, wish]);

  const saved = (nextWish: WishOut) => {
    onOpenChange(false);
    onSaved?.(nextWish);
  };
  const create = useActionMutation({
    mutationFn: api.wish.create.mutationOptions,
    success: (created) => `Created “${created.name}”`,
    invalidateKeys: wishMutationInvalidateKeys,
    onSuccess: saved,
  });
  const update = useActionMutation({
    mutationFn: api.wish.update.mutationOptions,
    success: "Wishlist updated",
    invalidateKeys: wishMutationInvalidateKeys,
    onSuccess: saved,
  });

  const isPending = create.isPending || update.isPending;
  const visibleProducts = (productsQuery.data?.items ?? []).filter(
    (product) => {
      const searchable = `${product.name} ${product.manufacturer} ${product.model ?? ""}`;
      return searchable.toLowerCase().includes(productSearch.toLowerCase());
    },
  );
  const toggleCandidate = (id: string, checked: boolean) => {
    setCandidateIds((current) =>
      checked
        ? [...current, id]
        : current.filter((candidateId) => candidateId !== id),
    );
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const data = {
      name: name.trim(),
      notes: notes.trim() || null,
      candidateProductIds: candidateIds,
    };
    if (!data.name) return;
    if (wish) {
      update.mutate({ id: wish.id, data });
    } else {
      create.mutate(data);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {wish ? "Edit wishlist item" : "New wishlist item"}
          </DialogTitle>
          <DialogDescription>
            Add one desired outcome, then optionally list the Tool products you
            would consider.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor={nameInputId}>What do you want?</Label>
            <Input
              id={nameInputId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Metal milling machine"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={notesInputId}>Notes</Label>
            <Textarea
              id={notesInputId}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Why it would be useful or fun, constraints, future project ideas…"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={productSearchInputId}>Tool alternatives</Label>
            <Input
              id={productSearchInputId}
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Filter your Tool products…"
            />
            <div className="max-h-48 space-y-1 overflow-y-auto border p-2">
              {visibleProducts.map((product) => {
                const checked = candidateIds.includes(product.id);
                const candidateInputId = `${idPrefix}-${product.id}`;
                return (
                  <div
                    key={product.id}
                    className="flex items-center gap-2 p-1 hover:bg-muted"
                  >
                    <Checkbox
                      id={candidateInputId}
                      checked={checked}
                      onCheckedChange={(value) =>
                        toggleCandidate(product.id, value === true)
                      }
                    />
                    <Label
                      htmlFor={candidateInputId}
                      className="min-w-0 cursor-pointer normal-case tracking-normal"
                    >
                      <span className="block truncate font-medium">
                        {product.name}
                      </span>
                      <span className="block truncate text-muted-foreground">
                        {product.manufacturer}
                        {product.model ? ` · ${product.model}` : ""}
                      </span>
                    </Label>
                  </div>
                );
              })}
              {!productsQuery.isLoading && visibleProducts.length === 0 && (
                <p className="p-1 text-muted-foreground">
                  No matching Tool products yet.
                </p>
              )}
            </div>
            <p className="text-muted-foreground">
              Choose any number of alternatives. They mean “pick one,” not a
              shopping cart.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()}>
              {wish ? "Save changes" : "Create wish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
