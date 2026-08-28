import type { Child, FC } from "hono/jsx";
import { Card } from "../admin/layout";
import { getImageUrl } from "../storage/images";

export type FormValues = {
  upc?: string;
  name?: string | null;
  manufacturer?: string | null;
  brand?: string | null;
  category?: string | null;
  description?: string | null;
  priceDollars?: number | null;
};

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parsePrice(value: unknown): number | null {
  const text = optionalString(value);
  if (text === null) return null;
  const price = Number.parseFloat(text);
  return Number.isFinite(price) ? price : null;
}

export function uploadedFile(value: unknown): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

export function readForm(body: Record<string, unknown>): FormValues {
  return {
    name: optionalString(body.name),
    manufacturer: optionalString(body.manufacturer),
    brand: optionalString(body.brand),
    category: optionalString(body.category),
    description: optionalString(body.description),
    priceDollars: parsePrice(body.priceDollars),
  };
}

export const ProductForm: FC<{
  action: string;
  submitLabel: string;
  values?: FormValues;
  upcReadOnly?: boolean;
  imageKey?: string | null;
  baseUrl?: string;
}> = ({ action, submitLabel, values = {}, upcReadOnly, imageKey, baseUrl }) => (
  <Card class="max-w-2xl p-6">
    <form
      method="post"
      action={action}
      enctype="multipart/form-data"
      class="grid gap-4"
    >
      <Field label="UPC">
        <input
          name="upc"
          value={values.upc ?? ""}
          required={!upcReadOnly}
          readonly={upcReadOnly}
          placeholder="012345678901"
          class={inputClass(upcReadOnly)}
        />
      </Field>
      <Field label="Name">
        <input
          name="name"
          value={values.name ?? ""}
          required
          class={inputClass()}
        />
      </Field>
      <div class="grid grid-cols-2 gap-4">
        <Field label="Brand">
          <input name="brand" value={values.brand ?? ""} class={inputClass()} />
        </Field>
        <Field label="Manufacturer">
          <input
            name="manufacturer"
            value={values.manufacturer ?? ""}
            class={inputClass()}
          />
        </Field>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <Field label="Category">
          <input
            name="category"
            value={values.category ?? ""}
            class={inputClass()}
          />
        </Field>
        <Field label="Price (USD)">
          <input
            name="priceDollars"
            type="number"
            step="0.01"
            min="0"
            value={values.priceDollars ?? ""}
            class={inputClass()}
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea name="description" rows={3} class={inputClass()}>
          {values.description ?? ""}
        </textarea>
      </Field>
      <ImageField imageKey={imageKey} baseUrl={baseUrl} />
      <div class="flex items-center gap-3 pt-2">
        <button
          type="submit"
          class="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          {submitLabel}
        </button>
        <a
          href="/admin/products"
          class="rounded-lg px-4 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-900"
        >
          Cancel
        </a>
      </div>
    </form>
  </Card>
);

const Field: FC<{ label: string; children?: Child }> = ({
  label,
  children,
}) => (
  <label class="block">
    <span class="mb-1 block text-sm font-medium text-zinc-700">{label}</span>
    {children}
  </label>
);

function inputClass(readOnly?: boolean): string {
  const base =
    "w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200";
  return readOnly ? `${base} bg-zinc-100 text-zinc-500` : base;
}

const ImageField: FC<{ imageKey?: string | null; baseUrl?: string }> = ({
  imageKey,
  baseUrl,
}) => (
  <div class="block">
    <span class="mb-1 block text-sm font-medium text-zinc-700">Image</span>
    <label
      id="imageDropzone"
      class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500 transition hover:border-zinc-400 hover:bg-zinc-100"
    >
      <span>Drag &amp; drop an image, paste, or click to browse</span>
      <input
        id="imageFile"
        name="imageFile"
        type="file"
        accept="image/*"
        class="sr-only"
      />
      <img
        id="imagePreview"
        alt="upload preview"
        class="mt-2 hidden h-24 w-24 rounded-md object-contain"
      />
    </label>
    {imageKey && baseUrl && (
      <div class="mt-2 flex items-center gap-2 text-xs text-zinc-500">
        <img
          src={getImageUrl(imageKey, baseUrl)}
          alt="current"
          class="h-12 w-12 rounded-md object-contain"
        />
        <span>Current image (replaced if you add a new one)</span>
      </div>
    )}
    <input
      name="imageUrl"
      type="url"
      placeholder="…or paste an image URL"
      class={`${inputClass()} mt-2`}
    />
    <script dangerouslySetInnerHTML={{ __html: IMAGE_SCRIPT }} />
  </div>
);

const IMAGE_SCRIPT = `
(function () {
  var input = document.getElementById('imageFile');
  var zone = document.getElementById('imageDropzone');
  var preview = document.getElementById('imagePreview');
  if (!input || !zone || !preview) return;
  function show(file) {
    if (!file) return;
    preview.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
  }
  function assign(file) {
    try {
      var dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch (e) {}
    show(file);
  }
  input.addEventListener('change', function () {
    if (input.files && input.files[0]) show(input.files[0]);
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) {
      e.preventDefault();
      zone.classList.add('border-zinc-500', 'bg-zinc-100');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) {
      e.preventDefault();
      zone.classList.remove('border-zinc-500', 'bg-zinc-100');
    });
  });
  zone.addEventListener('drop', function (e) {
    var files = (e.dataTransfer && e.dataTransfer.files) || [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].type.indexOf('image/') === 0) { assign(files[i]); break; }
    }
  });
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) { assign(f); e.preventDefault(); }
        break;
      }
    }
  });
})();
`;
