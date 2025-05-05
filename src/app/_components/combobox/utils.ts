import { type ProductTopLevelOut } from "~/schemas/product";
import { type LocationOut } from "~/schemas/location";
import { type ComboboxItem } from "~/app/_components/combobox";

export const buildProductComboboxItem = (
  product: ProductTopLevelOut,
): ComboboxItem => ({
  id: product.id,
  name: `${product.name} (${product.manufacturer})`,
});

export const buildLocationComboboxItem = (
  location: LocationOut,
): ComboboxItem => ({
  id: location.id,
  name: `${location.name} (${location.type})`,
});
