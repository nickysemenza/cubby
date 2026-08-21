import type { CollectionSlug } from "@cubby/schemas/collection";
import { formatCollectionLabel } from "@cubby/shared/collection-tag";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, MapPin } from "lucide-react";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";

export function CollectionDetailPage({
  collection,
  search,
  page,
  onSearchChange,
}: {
  collection: CollectionSlug;
  search?: string;
  page: number;
  onSearchChange: (next: { q?: string; page?: number }) => void;
}) {
  const api = useTRPC();
  const result = useQuery(
    api.collection.detail.queryOptions({
      collection,
      search,
      pagination: { pageIndex: page - 1, pageSize: 25 },
    }),
  );
  const data = result.data;
  const pageCount = Math.max(1, Math.ceil((data?.totalCount ?? 0) / 25));

  if (result.isLoading)
    return <p className="text-muted-foreground">Loading Collection…</p>;
  if (result.error)
    return <p className="text-destructive">{result.error.message}</p>;
  if (!data) return null;

  return (
    <Stack gap="lg">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-border border-b pb-2">
        <p className="text-muted-foreground text-xs">
          {data.collection.productCount} products · {data.roots.length} tagged
          locations
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/collections/assignments" />}
        >
          Manage assignments
        </Button>
      </div>

      <section>
        <h2 className="mb-2 font-semibold text-sm">Location roots</h2>
        {data.roots.length ? (
          <div className="flex flex-wrap gap-2">
            {data.roots.map((root) => (
              <Link
                key={root.id}
                to="/locations/$shortcode"
                params={{ shortcode: root.id }}
                className="inline-flex min-h-10 items-center gap-2 border border-border bg-card px-2 py-1 text-xs hover:bg-muted md:min-h-7"
              >
                <MapPin className="size-3.5" />
                {root.path.join(" / ")}
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            Membership currently comes from direct Product tags only.
          </p>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-sm">
            {formatCollectionLabel(collection)} products
          </h2>
          <Input
            className="w-full md:w-64"
            value={search ?? ""}
            onChange={(event) =>
              onSearchChange({ q: event.target.value || undefined, page: 1 })
            }
            placeholder="Search products"
            aria-label="Search products"
          />
        </div>
        <div className="border-border border-t">
          <Table className="table-auto">
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Membership</TableHead>
                <TableHead>Current placements</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.products.map((product) => (
                <TableRow key={product.id} className="align-top">
                  <TableCell>
                    <Link
                      to="/products/$shortcode"
                      params={{ shortcode: product.id }}
                      title={product.name}
                      className="font-medium hover:underline"
                    >
                      {product.name}
                    </Link>
                    <div className="text-muted-foreground">
                      {product.manufacturer}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {product.direct && (
                        <Badge variant="outline">Direct</Badge>
                      )}
                      {product.inherited && (
                        <Badge variant="secondary">From location</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {product.placements.length ? (
                      <div className="space-y-1">
                        {product.placements.map((placement) => (
                          <Link
                            key={placement.id}
                            to="/locations/$shortcode"
                            params={{ shortcode: placement.id }}
                            className="block hover:underline"
                          >
                            {placement.path.join(" / ")}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Unplaced</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.products.length === 0 && (
            <p className="py-8 text-center text-muted-foreground">
              No products match this search.
            </p>
          )}
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onSearchChange({ page: page - 1 })}
          >
            <ChevronLeft />
          </Button>
          <span className="font-mono text-2xs">
            {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= pageCount}
            onClick={() => onSearchChange({ page: page + 1 })}
          >
            <ChevronRight />
          </Button>
        </div>
      </section>
    </Stack>
  );
}
