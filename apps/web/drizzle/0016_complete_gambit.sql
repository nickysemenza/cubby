CREATE TABLE "Meal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"name" text,
	"sortOrder" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "MealRecipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mealId" uuid NOT NULL,
	"recipeId" uuid NOT NULL,
	"scale" real DEFAULT 1 NOT NULL,
	"sortOrder" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
ALTER TABLE "MealRecipe" ADD CONSTRAINT "MealRecipe_mealId_Meal_id_fk" FOREIGN KEY ("mealId") REFERENCES "public"."Meal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MealRecipe" ADD CONSTRAINT "MealRecipe_recipeId_Recipe_id_fk" FOREIGN KEY ("recipeId") REFERENCES "public"."Recipe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Meal_date_active_idx" ON "Meal" USING btree ("date") WHERE "Meal"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "MealRecipe_mealId_idx" ON "MealRecipe" USING btree ("mealId");--> statement-breakpoint
CREATE INDEX "MealRecipe_recipeId_idx" ON "MealRecipe" USING btree ("recipeId");