PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usda_food_nutrient` (
	`id` integer PRIMARY KEY NOT NULL,
	`fdc_id` integer NOT NULL,
	`nutrient_id` integer NOT NULL,
	`amount` real NOT NULL,
	`data_points` text,
	`derivation_id` text,
	`min` text,
	`max` text,
	`median` text,
	`loq` text,
	`footnote` text,
	`min_year_acquired` text,
	`percent_daily_value` text,
	FOREIGN KEY (`fdc_id`) REFERENCES `usda_food`(`fdc_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`nutrient_id`) REFERENCES `usda_nutrient`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_usda_food_nutrient`("id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max", "median", "loq", "footnote", "min_year_acquired", "percent_daily_value") SELECT "id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max", "median", "loq", "footnote", "min_year_acquired", "percent_daily_value" FROM `usda_food_nutrient`;--> statement-breakpoint
DROP TABLE `usda_food_nutrient`;--> statement-breakpoint
ALTER TABLE `__new_usda_food_nutrient` RENAME TO `usda_food_nutrient`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `food_nutrient_fdc_id` ON `usda_food_nutrient` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `food_nutrient_nutrient_id_idx` ON `usda_food_nutrient` (`nutrient_id`);--> statement-breakpoint
CREATE TABLE `__new_usda_nutrient` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit_name` text NOT NULL,
	`nutrient_nbr` text NOT NULL,
	`rank` text
);
--> statement-breakpoint
INSERT INTO `__new_usda_nutrient`("id", "name", "unit_name", "nutrient_nbr", "rank") SELECT "id", "name", "unit_name", "nutrient_nbr", "rank" FROM `usda_nutrient`;--> statement-breakpoint
DROP TABLE `usda_nutrient`;--> statement-breakpoint
ALTER TABLE `__new_usda_nutrient` RENAME TO `usda_nutrient`;