import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Heart, Plus } from "lucide-react";
import { useState } from "react";
import { usePageCount } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/integrations/trpc/react";
import { formatCurrency } from "~/lib/utils";
import { WishFormDialog } from "./wish-form-dialog";

export function WishList() {
  const api = useTRPC();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showAcquired, setShowAcquired] = useState(true);
  const wishesQuery = useQuery(
    api.wish.list.queryOptions({
      filters: {
        search: search.trim() || undefined,
        acquired: showAcquired ? undefined : false,
      },
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 100 },
    }),
  );
  usePageCount(wishesQuery.data?.meta.totalCount);
  const wishes = wishesQuery.data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          className="max-w-sm"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search wishlist"
        />
        <Button
          variant="outline"
          onClick={() => setShowAcquired((current) => !current)}
        >
          {showAcquired ? "Hide acquired" : "Show acquired"}
        </Button>
        <Button onClick={() => setOpen(true)}>
          <Plus /> New wish
        </Button>
      </div>
      {wishes.length === 0 && !wishesQuery.isLoading ? (
        <Empty>
          <EmptyMedia variant="icon">
            <Heart />
          </EmptyMedia>
          <EmptyTitle>Your wishlist is empty</EmptyTitle>
          <EmptyDescription>
            Keep a future tool, a fun idea, or a set of alternatives here until
            the moment is right.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className="divide-y border">
          {wishes.map((wish) => (
            <Link
              key={wish.id}
              to="/wishes/$shortcode"
              params={{ shortcode: wish.id }}
              className="block p-3 transition-colors hover:bg-muted"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{wish.name}</span>
                    {wish.acquiredAt && (
                      <Badge variant="positive">Acquired</Badge>
                    )}
                  </div>
                  {wish.notes && (
                    <p className="mt-1 line-clamp-2 text-muted-foreground">
                      {wish.notes}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-muted-foreground">
                  {wish.candidates.length} option
                  {wish.candidates.length === 1 ? "" : "s"}
                </span>
              </div>
              {wish.candidates.length > 0 && (
                <p className="mt-2 truncate text-muted-foreground">
                  {wish.candidates
                    .map(
                      (candidate) =>
                        `${candidate.manufacturer} ${candidate.name}${candidate.price === null ? "" : ` · ${formatCurrency(candidate.price)}`}`,
                    )
                    .join("  ·  ")}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
      <WishFormDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
