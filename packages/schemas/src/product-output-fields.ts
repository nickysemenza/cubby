import { z } from "zod";
import productDefinition from "./entity-definitions/00-product.entity";
import { readFieldSchemas } from "./entity-definitions/definition";

export const productTopLevelOut = z.object(readFieldSchemas(productDefinition));
