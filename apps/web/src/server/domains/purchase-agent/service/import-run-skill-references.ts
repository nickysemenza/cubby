/** Each bundled skill's `references/*.md`, keyed by path, for Pi's Run skills. */
export const skillReferences = {
  "photo-inventory-import": import.meta.glob<string>(
    "../../../../../../../.agents/skills/photo-inventory-import/references/*.md",
    { query: "?raw", import: "default", eager: true },
  ),
  "product-enrichment": import.meta.glob<string>(
    "../../../../../../../.agents/skills/product-enrichment/references/*.md",
    { query: "?raw", import: "default", eager: true },
  ),
};
