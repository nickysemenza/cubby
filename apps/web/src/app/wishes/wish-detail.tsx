import type { WishOut } from "@cubby/schemas/wish";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useTRPC } from "~/integrations/trpc/react";
import { wishMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { WishFormDialog } from "./wish-form-dialog";

export function WishDetail({ wish }: { wish: WishOut }) {
  const api = useTRPC();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const update = useActionMutation({
    mutationFn: api.wish.update.mutationOptions,
    success: wish.acquiredAt ? "Marked as still wanted" : "Marked as acquired",
    invalidateKeys: wishMutationInvalidateKeys,
  });
  const remove = useActionMutation({
    mutationFn: api.wish.delete.mutationOptions,
    success: "Wishlist item deleted",
    invalidateKeys: wishMutationInvalidateKeys,
    onSuccess: () => navigate({ to: "/wishes" }),
  });
  const toggleAcquired = () =>
    update.mutate({ id: wish.id, data: { acquired: !wish.acquiredAt } });
  const deleteWish = () => {
    if (window.confirm(`Delete “${wish.name}” from your wishlist?`))
      remove.mutate({ ids: [wish.id] });
  };

  return (
    <Page
      variant="detail"
      entity="wish"
      title={wish.name}
      heroNo={wish.id}
      rawData={wish}
      heroStamp={
        wish.acquiredAt ? { label: "Acquired", tone: "green" } : undefined
      }
      actions={
        <>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
          <Button
            variant="outline"
            onClick={toggleAcquired}
            disabled={update.isPending}
          >
            <Check />
            {wish.acquiredAt ? "Still wanted" : "Mark acquired"}
          </Button>
          <Button
            variant="destructive"
            onClick={deleteWish}
            disabled={remove.isPending}
          >
            <Trash2 /> Delete
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {wish.notes && (
          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            <CardContent className="whitespace-pre-wrap">
              {wish.notes}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Tool alternatives</CardTitle>
          </CardHeader>
          <CardContent>
            {wish.candidates.length === 0 ? (
              <p className="text-muted-foreground">
                No specific products yet — this is an open-ended idea.
              </p>
            ) : (
              <div className="divide-y border">
                {wish.candidates.map((candidate) => (
                  <Link
                    key={candidate.id}
                    to="/products/$shortcode"
                    params={{ shortcode: candidate.id }}
                    className="flex items-center justify-between gap-3 p-2 hover:bg-muted"
                  >
                    <span>
                      <span className="block font-medium">
                        {candidate.name}
                      </span>
                      <span className="text-muted-foreground">
                        {candidate.manufacturer}
                        {candidate.model ? ` · ${candidate.model}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {candidate.inventoried && (
                        <Badge variant="positive">In inventory</Badge>
                      )}
                      {candidate.price !== null && (
                        <span>{formatCurrency(candidate.price)}</span>
                      )}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <WishFormDialog open={editing} onOpenChange={setEditing} wish={wish} />
    </Page>
  );
}
