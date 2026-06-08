// Ambient typing shared by tRPC client consumers (web's api-contract, the mobile app).
//
// Why this exists: deriving the tRPC `AppRouter` type forces consumers to compile
// the web server source graph, some of which reads `import.meta.env`. This mirrors
// vite/client's permissive `ImportMetaEnv` (index signature `any`) WITHOUT pulling
// the heavy `vite` package into the contract package or the React Native app.
// It is type-only — it produces no runtime code.
interface ImportMetaEnv {
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly SSR: boolean;
  readonly BASE_URL: string;
  // Custom VITE_* / app vars are untyped, matching vite/client's `any` index signature.
  // biome-ignore lint/suspicious/noExplicitAny: mirrors vite/client ImportMetaEnv exactly.
  readonly [key: string]: any;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
