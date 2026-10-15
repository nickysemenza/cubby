import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { PickerField } from "~/ui/forms/form-utils/picker-field";
import { Stack } from "~/ui/layout";

import { Demo, DemoGrid } from "../components/design-section";
import {
  demoCategoryOptions,
  demoLocationOptions,
  demoProductItems,
  demoStatusOptions,
  demoStorageOptions,
} from "../data/samples";

const VIEW_OPTIONS: PickerOption[] = [
  { value: "table", label: "Table", icon: <TableIcon /> },
  { value: "cards", label: "Cards", icon: <SquaresFourIcon /> },
  { value: "board", label: "Board", icon: <KanbanIcon /> },
  { value: "calendar", label: "Calendar", icon: <CalendarBlankIcon /> },
];

const matching = (items: ComboboxItem[], query: string) =>
  items.filter((item) =>
    item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

function PickerFieldDemo({ products }: { products: ComboboxItem[] }) {
  const form = useForm<{
    storage: string | null;
    category: string | null;
    product: ComboboxItem | null;
  }>({
    defaultValues: { storage: "pantry", category: null, product: null },
    // A server-reported error, so the invalid state shows without submitting.
    errors: {
      category: {
        type: "required",
        message: "Pick a category so spend rolls up.",
      },
    },
  });
  const [query, setQuery] = useState("");
  return (
    <Stack gap="sm">
      <PickerField
        form={form}
        name="storage"
        store="option"
        label="Storage"
        options={demoStorageOptions}
      />
      <PickerField
        form={form}
        name="category"
        store="option"
        label="Category"
        nullable
        noneLabel="No category"
        options={demoCategoryOptions}
        mode="search"
        description="More than twelve options default to search; this one asks for it."
      />
      <PickerField
        form={form}
        name="product"
        store="item"
        entity="product"
        label="Product"
        items={matching(products, query)}
        onSearchChange={setQuery}
        onCreateNew={async (name) => ({ id: `demo-new-${name}`, name })}
      />
    </Stack>
  );
}

export function PickerSection() {
  const products = useMemo(demoProductItems, []);
  const [storage, setStorage] = useState<string | null>("fridge");
  const [view, setView] = useState<string | null>("table");
  const [product, setProduct] = useState<ComboboxItem | null>(
    products[0] ?? null,
  );
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<string[]>(["low", "out"]);
  const [basket, setBasket] = useState<ComboboxItem[]>(products.slice(1, 3));
  const [location, setLocation] = useState<string | null>("kitchen-pantry-top");

  return (
    <Stack gap="md">
      <DemoGrid>
        <Demo
          name={'<Picker mode="choose" options />'}
          note="A short fixed list: arrows, Home/End and letter typeahead, no text entry. Disabled options say why."
        >
          <Picker
            mode="choose"
            label="Storage"
            options={demoStorageOptions}
            value={storage}
            onValueChange={setStorage}
          />
        </Demo>
        <Demo
          name={'<Picker mode="segmented" options />'}
          note="Two to five view modes inline, where seeing every choice is the point."
        >
          <Picker
            mode="segmented"
            label="View"
            options={VIEW_OPTIONS}
            value={view}
            onValueChange={setView}
          />
        </Demo>
        <Demo
          name={'<Picker entity="product" items />'}
          note="Search mode over records: pictures, muted context, grouped results, mono price and on-hand chips."
        >
          <Picker
            entity="product"
            label="Product"
            items={matching(products, query)}
            onSearchChange={setQuery}
            value={product}
            setValue={setProduct}
            clearable
            onCreateNew={async (name) => ({ id: `demo-new-${name}`, name })}
          />
        </Demo>
        <Demo
          name="<Picker multiple options />"
          note="A checklist with a meta predicate above the divider and counts as hints."
        >
          <Picker
            multiple
            label="Status"
            options={demoStatusOptions}
            values={statuses}
            onValuesChange={setStatuses}
            placeholder="Any status"
          />
        </Demo>
        <Demo
          name={'<Picker multiple entity="product" items />'}
          note="Several records; the selection shows as removable chips with 16px pictures."
        >
          <Picker
            multiple
            entity="product"
            label="Basket"
            items={products}
            values={basket}
            setValues={setBasket}
          />
        </Demo>
        <Demo
          name="<Picker options={tree} />"
          note="A hierarchy reads through quiet group headings and indent, never a breadcrumb per row."
        >
          <Picker
            label="Location"
            options={demoLocationOptions}
            value={location}
            onValueChange={setLocation}
            clearable
          />
        </Demo>
        <Demo
          name="<Picker disabled />"
          note="Disabled keeps the selected mark."
        >
          <Picker
            mode="choose"
            label="Storage (disabled)"
            options={demoStorageOptions}
            value="freezer"
            onValueChange={() => {}}
            disabled
          />
        </Demo>
        <Demo name="<Picker isLoading />" note="A roster still loading.">
          <Picker
            entity="product"
            label="Product (loading)"
            items={[]}
            value={null}
            setValue={() => {}}
            isLoading
            placeholder="Find a product"
          />
        </Demo>
        <Demo
          name={'<Picker error="…" />'}
          note="A failed roster read keeps its raw message."
        >
          <Picker
            entity="product"
            label="Product (failed)"
            items={[]}
            value={null}
            setValue={() => {}}
            error="HTTP 503 from /api/products: upstream timed out"
            placeholder="Find a product"
          />
        </Demo>
        <Demo
          name="<PickerField store=…>"
          note="The one react-hook-form binding: option, item, id, name and ids stores share the field chrome and errors."
          className="md:col-span-2 xl:col-span-1"
        >
          <PickerFieldDemo products={products} />
        </Demo>
      </DemoGrid>
    </Stack>
  );
}
