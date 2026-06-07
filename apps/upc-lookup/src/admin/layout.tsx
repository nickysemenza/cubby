import type { FC, Child } from "hono/jsx";

export type FlashType = "success" | "error";
export type Flash = { type: FlashType; message: string };

/** Read a flash message from query params (set on POST-redirect). */
export function flashFromQuery(
  flash: string | undefined,
  type: string | undefined,
): Flash | undefined {
  if (!flash) return undefined;
  return { type: type === "error" ? "error" : "success", message: flash };
}

/** Build a redirect path with a flash message attached. */
export function withFlash(
  path: string,
  message: string,
  type: FlashType = "success",
): string {
  const params = new URLSearchParams({ flash: message, flashType: type });
  return `${path}?${params.toString()}`;
}

type NavKey = "products" | "new" | "stats";

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "products", href: "/admin/products", label: "Products" },
  { key: "new", href: "/admin/products/new", label: "New" },
  { key: "stats", href: "/admin/stats", label: "Stats" },
];

export const Layout: FC<{
  title: string;
  active?: NavKey;
  flash?: Flash;
  children?: Child;
}> = ({ title, active, flash, children }) => (
  <div class="min-h-screen bg-zinc-50 text-zinc-900">
    <header class="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur">
      <div class="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
        <a
          href="/admin"
          class="flex items-center gap-2 font-semibold tracking-tight"
        >
          <BarcodeMark />
          <span>UPC Lookup</span>
        </a>
        <nav class="flex items-center gap-1 text-sm">
          {NAV.map((item) => (
            <a
              href={item.href}
              class={
                item.key === active
                  ? "rounded-md bg-zinc-100 px-3 py-1.5 font-medium text-zinc-900"
                  : "rounded-md px-3 py-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              }
            >
              {item.label}
            </a>
          ))}
        </nav>
        <a
          href="/admin/logout"
          class="ml-auto rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:bg-red-50 hover:text-red-700"
        >
          Logout
        </a>
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-4 py-8">
      <h1 class="mb-6 text-2xl font-bold tracking-tight">{title}</h1>
      {flash && <FlashBanner flash={flash} />}
      {children}
    </main>
  </div>
);

const FlashBanner: FC<{ flash: Flash }> = ({ flash }) => (
  <div
    class={
      flash.type === "error"
        ? "mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        : "mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
    }
  >
    {flash.message}
  </div>
);

export const Card: FC<{ class?: string; children?: Child }> = ({
  class: className,
  children,
}) => (
  <div
    class={`rounded-xl border border-zinc-200 bg-white shadow-sm ${className ?? ""}`}
  >
    {children}
  </div>
);

const SOURCE_BADGE_CLASS: Record<string, string> = {
  upcitemdb: "bg-blue-50 text-blue-700 ring-blue-600/20",
  manual: "bg-amber-50 text-amber-700 ring-amber-600/20",
};

export const SourceBadge: FC<{ source: string }> = ({ source }) => (
  <span
    class={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
      SOURCE_BADGE_CLASS[source] ?? "bg-zinc-100 text-zinc-600 ring-zinc-500/20"
    }`}
  >
    {source}
  </span>
);

const BarcodeMark: FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2" y="3" width="2" height="14" fill="currentColor" />
    <rect x="6" y="3" width="1" height="14" fill="currentColor" />
    <rect x="9" y="3" width="2" height="14" fill="currentColor" />
    <rect x="13" y="3" width="1" height="14" fill="currentColor" />
    <rect x="16" y="3" width="2" height="14" fill="currentColor" />
  </svg>
);
