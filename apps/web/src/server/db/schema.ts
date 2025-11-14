import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { type Amount } from "~/codec/codec";
import {
  user,
  organization,
  member as organizationMember,
  session,
  account,
  verification,
  invitation,
  apikey,
} from "./auth.schema";

// JSON types for JSONB columns
export type { Amount };
export type Instruction = { text: string };

// Re-export Better-Auth tables for use throughout the app
export {
  user,
  organization,
  organizationMember,
  session,
  account,
  verification,
  invitation,
  apikey,
};

// Enums
export const recipeSourceEnum = pgEnum("RecipeSource", [
  "Book",
  "Website",
  "Other",
]);
export const imageStatusEnum = pgEnum("ImageStatus", [
  "PENDING",
  "UPLOADED",
  "FAILED",
]);

// Recipe table
export const recipe = pgTable(
  "Recipe",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id),
    name: text("name").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    SourceType: recipeSourceEnum("SourceType"),
    SourceData: text("SourceData"),
  },
  (table) => ({
    projectNameUnique: uniqueIndex("Recipe_organizationId_name_key").on(
      table.organizationId,
      table.name,
    ),
    projectIdIdx: index("Recipe_organizationId_idx").on(table.organizationId),
    createdAtIdx: index("Recipe_createdAt_idx").on(table.createdAt),
    sourceTypeIdx: index("Recipe_SourceType_idx").on(table.SourceType),
    // GIN index for full-text search on name
    nameGinIdx: index("Recipe_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    createdAtDescIdx: index("Recipe_created_at_desc_idx").on(
      table.createdAt.desc(),
    ),
  }),
);

// RecipeSection table
export const recipeSection = pgTable(
  "RecipeSection",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recipeId: uuid("recipeId")
      .notNull()
      .references(() => recipe.id),
    name: text("name"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    instructions: jsonb("instructions")
      .notNull()
      .$type<Instruction[]>()
      .default(sql`'[]'::jsonb`),
  },
  (table) => ({
    recipeIdIdx: index("RecipeSection_recipeId_idx").on(table.recipeId),
    createdAtIdx: index("RecipeSection_createdAt_idx").on(table.createdAt),
  }),
);

// Ingredient table
export const ingredient = pgTable(
  "Ingredient",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id),
    name: text("name").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    recipeId: uuid("recipeId").references(() => recipe.id),
  },
  (table) => ({
    projectNameUnique: uniqueIndex("Ingredient_organizationId_name_key").on(
      table.organizationId,
      table.name,
    ),
    recipeIdUnique: uniqueIndex("Ingredient_recipeId_key").on(table.recipeId),
    projectIdIdx: index("Ingredient_organizationId_idx").on(
      table.organizationId,
    ),
    recipeIdIdx: index("Ingredient_recipeId_idx").on(table.recipeId),
    createdAtIdx: index("Ingredient_createdAt_idx").on(table.createdAt),
    // GIN indexes for full-text search
    nameGinIdx: index("Ingredient_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    aliasesGinIdx: index("Ingredient_aliases_gin_idx").using(
      "gin",
      table.aliases,
    ),
  }),
);

// RecipeSectionIngredient table
export const recipeSectionIngredient = pgTable(
  "RecipeSectionIngredient",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recipeSectionId: uuid("recipeSectionId")
      .notNull()
      .references(() => recipeSection.id),
    ingredientId: uuid("ingredientId")
      .notNull()
      .references(() => ingredient.id),
    amounts: jsonb("amounts")
      .notNull()
      .$type<Amount[]>()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => ({
    recipeSectionIdIdx: index("RecipeSectionIngredient_recipeSectionId_idx").on(
      table.recipeSectionId,
    ),
    ingredientIdIdx: index("RecipeSectionIngredient_ingredientId_idx").on(
      table.ingredientId,
    ),
  }),
);

// Product table
export const product = pgTable(
  "Product",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id),
    name: text("name").notNull(),
    manufacturer: text("manufacturer").notNull(),
    upc: text("upc"),
    ndb_number: integer("ndb_number"),
    model: text("model"),
    expectedQuantity: integer("expectedQuantity"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    ingredientId: uuid("ingredientId").references(() => ingredient.id),
  },
  (table) => ({
    projectNameMfgUnique: uniqueIndex(
      "Product_organizationId_name_manufacturer_key",
    ).on(table.organizationId, table.name, table.manufacturer),
    upcUnique: uniqueIndex("Product_upc_key").on(table.upc),
    ndbUnique: uniqueIndex("Product_ndb_number_key").on(table.ndb_number),
    projectIdIdx: index("Product_organizationId_idx").on(table.organizationId),
    ingredientIdIdx: index("Product_ingredientId_idx").on(table.ingredientId),
    createdAtIdx: index("Product_createdAt_idx").on(table.createdAt),
    nameIdx: index("Product_name_idx").on(table.name),
    // GIN indexes for full-text search
    nameGinIdx: index("Product_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    manufacturerGinIdx: index("Product_manufacturer_gin_idx").using(
      "gin",
      sql`${table.manufacturer} gin_trgm_ops`,
    ),
    nameMfgIdx: index("Product_name_manufacturer_idx").on(
      table.name,
      table.manufacturer,
    ),
  }),
);

// ProductUnitMappings table
export const productUnitMappings = pgTable(
  "ProductUnitMappings",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    productId: uuid("productId")
      .notNull()
      .references(() => product.id),
    a: jsonb("a").notNull().$type<Amount>(),
    b: jsonb("b").notNull().$type<Amount>(),
    source: text("source"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => ({
    productIdIdx: index("ProductUnitMappings_productId_idx").on(
      table.productId,
    ),
  }),
);

// Location table
export const location = pgTable(
  "Location",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id),
    name: text("name").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    lastBulkInventory: timestamp("lastBulkInventory", { mode: "date" }),
    parentId: uuid("parentId"),
    type: text("type").notNull(),
  },
  (table) => ({
    projectNameUnique: uniqueIndex("Location_organizationId_name_key").on(
      table.organizationId,
      table.name,
    ),
    projectIdIdx: index("Location_organizationId_idx").on(table.organizationId),
    nameIdx: index("Location_name_idx").on(table.name),
    typeIdx: index("Location_type_idx").on(table.type),
    parentIdIdx: index("Location_parentId_idx").on(table.parentId),
    createdAtIdx: index("Location_createdAt_idx").on(table.createdAt),
    lastBulkInventoryIdx: index("Location_lastBulkInventory_idx").on(
      table.lastBulkInventory,
    ),
    // GIN index for full-text search
    nameGinIdx: index("Location_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    typeNameIdx: index("Location_type_name_idx").on(table.type, table.name),
  }),
);

// InventoryEntry table
export const inventoryEntry = pgTable(
  "InventoryEntry",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id),
    productId: uuid("productId")
      .notNull()
      .references(() => product.id),
    amount: jsonb("amount").notNull().$type<Amount>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    locationId: uuid("locationId")
      .notNull()
      .references(() => location.id),
  },
  (table) => ({
    productLocationUnique: uniqueIndex(
      "InventoryEntry_productId_locationId_key",
    ).on(table.productId, table.locationId),
    projectIdIdx: index("InventoryEntry_organizationId_idx").on(
      table.organizationId,
    ),
    productIdIdx: index("InventoryEntry_productId_idx").on(table.productId),
    locationIdIdx: index("InventoryEntry_locationId_idx").on(table.locationId),
    createdAtIdx: index("InventoryEntry_createdAt_idx").on(table.createdAt),
  }),
);

// Image table
export const image = pgTable(
  "Image",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organizationId")
      .notNull()
      .references(() => organization.id),
    url: text("url").notNull(),
    key: text("key").notNull().unique(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    contentType: text("contentType").notNull(),
    status: imageStatusEnum("status").notNull().default("PENDING"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => ({
    projectIdIdx: index("Image_organizationId_idx").on(table.organizationId),
    createdAtIdx: index("Image_createdAt_idx").on(table.createdAt),
    statusIdx: index("Image_status_idx").on(table.status),
  }),
);

// ProductImage table
export const productImage = pgTable(
  "ProductImage",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    productId: uuid("productId")
      .notNull()
      .references(() => product.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => ({
    productImageUnique: uniqueIndex("ProductImage_productId_imageId_key").on(
      table.productId,
      table.imageId,
    ),
    productIdIdx: index("ProductImage_productId_idx").on(table.productId),
    imageIdIdx: index("ProductImage_imageId_idx").on(table.imageId),
  }),
);

// LocationImage table
export const locationImage = pgTable(
  "LocationImage",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("locationId")
      .notNull()
      .references(() => location.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => ({
    locationImageUnique: uniqueIndex("LocationImage_locationId_imageId_key").on(
      table.locationId,
      table.imageId,
    ),
    locationIdIdx: index("LocationImage_locationId_idx").on(table.locationId),
    imageIdIdx: index("LocationImage_imageId_idx").on(table.imageId),
  }),
);

// RecipeImage table
export const recipeImage = pgTable(
  "RecipeImage",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    recipeId: uuid("recipeId")
      .notNull()
      .references(() => recipe.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => ({
    recipeImageUnique: uniqueIndex("RecipeImage_recipeId_imageId_key").on(
      table.recipeId,
      table.imageId,
    ),
    recipeIdIdx: index("RecipeImage_recipeId_idx").on(table.recipeId),
    imageIdIdx: index("RecipeImage_imageId_idx").on(table.imageId),
  }),
);

// Relations
export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(organizationMember),
  recipes: many(recipe),
  products: many(product),
  ingredients: many(ingredient),
  locations: many(location),
  inventoryEntries: many(inventoryEntry),
  images: many(image),
}));

export const recipeRelations = relations(recipe, ({ one, many }) => ({
  organization: one(organization, {
    fields: [recipe.organizationId],
    references: [organization.id],
  }),
  sections: many(recipeSection),
  pointerIngredient: one(ingredient, {
    fields: [recipe.id],
    references: [ingredient.recipeId],
  }),
  images: many(recipeImage),
}));

export const recipeSectionRelations = relations(
  recipeSection,
  ({ one, many }) => ({
    recipe: one(recipe, {
      fields: [recipeSection.recipeId],
      references: [recipe.id],
    }),
    ingredients: many(recipeSectionIngredient),
  }),
);

export const ingredientRelations = relations(ingredient, ({ one, many }) => ({
  organization: one(organization, {
    fields: [ingredient.organizationId],
    references: [organization.id],
  }),
  Recipe: one(recipe, {
    fields: [ingredient.recipeId],
    references: [recipe.id],
  }),
  RecipeSectionIngredient: many(recipeSectionIngredient),
  Product: many(product),
}));

export const recipeSectionIngredientRelations = relations(
  recipeSectionIngredient,
  ({ one }) => ({
    recipeSection: one(recipeSection, {
      fields: [recipeSectionIngredient.recipeSectionId],
      references: [recipeSection.id],
    }),
    ingredient: one(ingredient, {
      fields: [recipeSectionIngredient.ingredientId],
      references: [ingredient.id],
    }),
  }),
);

export const productRelations = relations(product, ({ one, many }) => ({
  organization: one(organization, {
    fields: [product.organizationId],
    references: [organization.id],
  }),
  Ingredient: one(ingredient, {
    fields: [product.ingredientId],
    references: [ingredient.id],
  }),
  unitMappings: many(productUnitMappings),
  InventoryEntry: many(inventoryEntry),
  images: many(productImage),
}));

export const productUnitMappingsRelations = relations(
  productUnitMappings,
  ({ one }) => ({
    product: one(product, {
      fields: [productUnitMappings.productId],
      references: [product.id],
    }),
  }),
);

export const locationRelations = relations(location, ({ one, many }) => ({
  organization: one(organization, {
    fields: [location.organizationId],
    references: [organization.id],
  }),
  parent: one(location, {
    fields: [location.parentId],
    references: [location.id],
    relationName: "LocationToLocation",
  }),
  children: many(location, {
    relationName: "LocationToLocation",
  }),
  InventoryEntries: many(inventoryEntry),
  images: many(locationImage),
}));

export const inventoryEntryRelations = relations(inventoryEntry, ({ one }) => ({
  organization: one(organization, {
    fields: [inventoryEntry.organizationId],
    references: [organization.id],
  }),
  Product: one(product, {
    fields: [inventoryEntry.productId],
    references: [product.id],
  }),
  location: one(location, {
    fields: [inventoryEntry.locationId],
    references: [location.id],
  }),
}));

export const imageRelations = relations(image, ({ one, many }) => ({
  organization: one(organization, {
    fields: [image.organizationId],
    references: [organization.id],
  }),
  productImages: many(productImage),
  locationImages: many(locationImage),
  recipeImages: many(recipeImage),
}));

export const productImageRelations = relations(productImage, ({ one }) => ({
  product: one(product, {
    fields: [productImage.productId],
    references: [product.id],
  }),
  image: one(image, {
    fields: [productImage.imageId],
    references: [image.id],
  }),
}));

export const locationImageRelations = relations(locationImage, ({ one }) => ({
  location: one(location, {
    fields: [locationImage.locationId],
    references: [location.id],
  }),
  image: one(image, {
    fields: [locationImage.imageId],
    references: [image.id],
  }),
}));

export const recipeImageRelations = relations(recipeImage, ({ one }) => ({
  recipe: one(recipe, {
    fields: [recipeImage.recipeId],
    references: [recipe.id],
  }),
  image: one(image, {
    fields: [recipeImage.imageId],
    references: [image.id],
  }),
}));
