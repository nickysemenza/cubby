import { ImageIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { CubbyColumnHelper as ColumnHelper } from "~/app/_components/data-table/table-features";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "~/app/_components/products/product-image-summaries";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";

type ProductLinkedRow = { productId: string | null };

/**
 * Product cover column for expense ledgers. Images are fetched independently
 * from the expense query, so soft-deleted or unlinked products stay honest
 * blank/placeholder rows instead of making the ledger response heavier.
 */
export function createExpenseProductImageColumn<T extends ProductLinkedRow>(
  columnHelper: ColumnHelper<T>,
) {
  return columnHelper.accessor((row) => row.productId, {
    id: "image",
    header: () => <ImageIcon className="size-3 text-muted-foreground" />,
    enableSorting: false,
    meta: {
      className: "h-px w-16 overflow-hidden px-0 py-0",
      mobile: { slot: "image", priority: -10 },
    },
    cell: (info) => <ExpenseProductImageCell productId={info.getValue()} />,
  });
}

export function ExpenseProductImages({
  rows,
  children,
}: {
  rows: readonly ProductLinkedRow[];
  children: ReactNode;
}) {
  const productIds = useMemo(
    () => [
      ...new Set(rows.flatMap((row) => (row.productId ? [row.productId] : []))),
    ],
    [rows],
  );
  return (
    <ProductImageSummariesProvider productIds={productIds}>
      {children}
    </ProductImageSummariesProvider>
  );
}

function ExpenseProductImageCell({ productId }: { productId: string | null }) {
  const images = useHydratedProductImages(productId ?? "");
  return (
    <ImageThumbnail
      images={images}
      alt="Product image"
      lazyPreview={true}
      entity="product"
    />
  );
}
