PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usda_food` (
	`fdc_id` integer PRIMARY KEY NOT NULL,
	`data_type` text NOT NULL,
	`description` text NOT NULL,
	`food_category_id` text,
	`publication_date` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_usda_food`("fdc_id", "data_type", "description", "food_category_id", "publication_date") SELECT "fdc_id", "data_type", "description", "food_category_id", "publication_date" FROM `usda_food`;--> statement-breakpoint
DROP TABLE `usda_food`;--> statement-breakpoint
ALTER TABLE `__new_usda_food` RENAME TO `usda_food`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `food_fdc_id` ON `usda_food` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `usda_food_description_idx` ON `usda_food` (`description`);--> statement-breakpoint
CREATE INDEX `usda_food_data_type_idx` ON `usda_food` (`data_type`);--> statement-breakpoint
CREATE TABLE `__new_usda_food_portion` (
	`id` integer PRIMARY KEY NOT NULL,
	`fdc_id` integer NOT NULL,
	`seq_num` text,
	`amount` real,
	`measure_unit_id` integer NOT NULL,
	`portion_description` text,
	`modifier` text,
	`gram_weight` real NOT NULL,
	`data_points` text,
	`footnote` text,
	`min_year_acquired` text,
	FOREIGN KEY (`fdc_id`) REFERENCES `usda_food`(`fdc_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`measure_unit_id`) REFERENCES `usda_measure_unit`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_usda_food_portion`("id", "fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier", "gram_weight", "data_points", "footnote", "min_year_acquired") SELECT "id", "fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier", "gram_weight", "data_points", "footnote", "min_year_acquired" FROM `usda_food_portion`;--> statement-breakpoint
DROP TABLE `usda_food_portion`;--> statement-breakpoint
ALTER TABLE `__new_usda_food_portion` RENAME TO `usda_food_portion`;--> statement-breakpoint
CREATE INDEX `food_portion_fdc_id` ON `usda_food_portion` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `food_portion_measure_unit_id_idx` ON `usda_food_portion` (`measure_unit_id`);--> statement-breakpoint
CREATE TABLE `__new_usda_nutrient` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit_name` text NOT NULL,
	`nutrient_nbr` text,
	`rank` text
);
--> statement-breakpoint
INSERT INTO `__new_usda_nutrient`("id", "name", "unit_name", "nutrient_nbr", "rank") SELECT "id", "name", "unit_name", "nutrient_nbr", "rank" FROM `usda_nutrient`;--> statement-breakpoint
DROP TABLE `usda_nutrient`;--> statement-breakpoint
ALTER TABLE `__new_usda_nutrient` RENAME TO `usda_nutrient`;