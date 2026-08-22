import type {
  CookbookShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { BookMarked, Link2, Link2Off } from "lucide-react";
import { useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/integrations/trpc/react";
import { cookbookProductLinkInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";

const SEARCH_PAGE_SIZE = 20;

/**
 * The physical copy of a cookbook: the book on the shelf behind the EPUB.
 *
 * Most links are made without this panel — an EPUB whose OPF declares an ISBN
 * resolves to its Product during import. This is the manual path for the rest:
 * books whose EPUB carries only a Calibre UUID, and the cookbooks imported
 * before that resolution existed.
 *
 * Price and shelf location come from a separate `product.getByShortcode`, fired
 * only once a link exists. That keeps `listCookbooks` — which also feeds the
 * browse gallery, the cookbook picker, the hover preview and MCP — free of
 * pricing and inventory joins that only this one panel reads.
 */
export function CookbookPhysicalCopy({
  cookbookId,
  cookbookName,
  product,
}: {
  cookbookId: CookbookShortcode;
  cookbookName: string;
  product: {
    id: ProductShortcode;
    name: string;
    coverUrl: string | null;
  } | null;
}) {
  const api = useTRPC();
  const [pickerOpen, setPickerOpen] = useState(false);

  const setProduct = useActionMutation({
    mutationFn: api.recipe.setCookbookProduct.mutationOptions,
    success: (result) =>
      result.product
        ? `Linked to ${result.product.name}`
        : "Unlinked the physical copy",
    invalidateKeys: cookbookProductLinkInvalidateKeys,
    onSuccess: () => setPickerOpen(false),
  });

  const detail = useQuery({
    // `shortcode` is non-null whenever this query is enabled; the fallback
    // only satisfies the input type on the disabled render.
    ...api.product.getByShortcode.queryOptions({
      shortcode: product?.id ?? ("" as ProductShortcode),
    }),
    enabled: product != null,
  });

  if (!product) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
          title="Record which product on the shelf is this book"
        >
          <Link2 className="mr-2 size-4" />
          Link physical copy
        </Button>
        <ProductPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          cookbookName={cookbookName}
          isPending={setProduct.isPending}
          onPick={(productId) => setProduct.mutate({ cookbookId, productId })}
        />
      </>
    );
  }

  // Every live shelf placement, not just the first: a book can sit in two
  // rooms, and naming only one would be quietly wrong.
  const shelvedAt = (detail.data?.inventoryEntry ?? []).map(
    (entry) => entry.location.name,
  );
  const price = detail.data?.pricing.effectivePrice;

  return (
    <Row
      align="center"
      gap="md"
      className="my-4 w-fit rounded-sm border border-[var(--border)] bg-card p-2"
    >
      {product.coverUrl ? (
        <Image
          src={product.coverUrl}
          alt={product.name}
          displayWidth={40}
          className="h-14 w-10 object-cover"
        />
      ) : (
        <BookMarked className="size-5 text-muted-foreground" />
      )}
      <Stack gap="xs">
        <EntityInlineLink
          displayImage={undefined}
          entity="product"
          data={{ id: product.id, name: product.name }}
        />
        <Description size="xs">
          {[
            price != null ? formatCurrency(price) : null,
            shelvedAt.length > 0 ? shelvedAt.join(", ") : "not on a shelf",
          ]
            .filter(Boolean)
            .join(" · ")}
        </Description>
      </Stack>
      <Button
        variant="ghost"
        size="sm"
        disabled={setProduct.isPending}
        onClick={() => setProduct.mutate({ cookbookId, productId: null })}
        title="This product isn't this book"
      >
        <Link2Off className="size-4" />
      </Button>
    </Row>
  );
}

/**
 * Single-select product search.
 *
 * Deliberately offers no ranked "best match" ordering. Every signal available
 * at this point is the book's NAME, and a name match is exactly what confuses
 * different books that share one: "Tartine Book No. 3" and "Tartine: A Classic
 * Revisited" are not the same book, and a list that put the wrong one on top
 * would be read as an endorsement. The identity-grade match (the EPUB's ISBN)
 * already happened at import if it was going to.
 */
function ProductPickerDialog({
  open,
  onOpenChange,
  cookbookName,
  isPending,
  onPick,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  cookbookName: string;
  isPending: boolean;
  onPick: (productId: ProductShortcode) => void;
}) {
  const api = useTRPC();
  const [searchInput, setSearchInput] = useState(cookbookName);
  const [search] = useDebouncedValue(searchInput, { wait: 300 });

  const searchQuery = useQuery({
    ...api.product.search.queryOptions({
      filters: { nameFilter: search.trim() || undefined },
      pagination: { pageIndex: 0, pageSize: SEARCH_PAGE_SIZE },
      sort: [{ orderBy: "name", direction: "asc" }],
    }),
    enabled: open,
  });
  const items = searchQuery.data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link physical copy</DialogTitle>
          <DialogDescription>
            Which product on the shelf is “{cookbookName}”? Check the edition —
            two books can share a title and be different printings.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search products…"
        />
        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <Empty variant="minimal" className="py-6">
              <EmptyTitle>No products found</EmptyTitle>
              <EmptyDescription>
                Adjust the search, or add the book as a product first.
              </EmptyDescription>
            </Empty>
          ) : (
            <Stack gap="xs">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => onPick(item.id)}
                  className="flex w-full items-center gap-3 rounded-sm p-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {item.coverImageUrl ? (
                    <Image
                      src={item.coverImageUrl}
                      alt={item.name}
                      displayWidth={32}
                      className="h-11 w-8 shrink-0 object-cover"
                    />
                  ) : (
                    <BookMarked className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <Stack gap="xs">
                    <span className="text-sm">{item.name}</span>
                    <Description size="xs">{item.id}</Description>
                  </Stack>
                </button>
              ))}
            </Stack>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
