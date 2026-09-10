import { z } from "zod";
import imageDefinition from "./18-image.entity";
import { readFieldSchemas } from "./definition";

export const imageOut = z.object(readFieldSchemas(imageDefinition));
