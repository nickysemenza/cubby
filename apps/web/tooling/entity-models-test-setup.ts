import { entityKeys } from "@cubby/schemas/entity-index";

import { loadEntityModels } from "~/entity/entity-model";

// In the app a route's generated client module registers the models its page
// reads; a test renders components without that route, so every model is
// registered up front (docs/adr/0009-per-entity-client-manifests.md).
await loadEntityModels(entityKeys);
