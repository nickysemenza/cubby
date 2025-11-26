export const metadata = {
  title: "Component Demos - RecipeHub",
  description: "View-only component demos showcasing RecipeHub UI",
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <main className="mx-auto max-w-4xl px-8 py-12">{children}</main>;
}
