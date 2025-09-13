CREATE TABLE `usda_branded_food` (
	`fdc_id` integer PRIMARY KEY NOT NULL,
	`brand_owner` text,
	`brand_name` text,
	`subbrand_name` text,
	`gtin_upc` text NOT NULL,
	`ingredients` text,
	`not_a_significant_source_of` text,
	`serving_size` real,
	`serving_size_unit` text,
	`household_serving_fulltext` text,
	`branded_food_category` text,
	`data_source` text,
	`package_weight` text,
	`modified_date` text,
	`available_date` text,
	`market_country` text,
	`discontinued_date` text,
	`preparation_state_code` text,
	`trade_channel` text,
	`short_description` text,
	`material_code` text,
	FOREIGN KEY (`fdc_id`) REFERENCES `usda_food`(`fdc_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `branded_food_fdc_id` ON `usda_branded_food` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `branded_food_upc` ON `usda_branded_food` (`gtin_upc`);--> statement-breakpoint
CREATE TABLE `usda_food` (
	`fdc_id` integer PRIMARY KEY NOT NULL,
	`data_type` text NOT NULL,
	`description` text,
	`food_category_id` text,
	`publication_date` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `food_fdc_id` ON `usda_food` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `usda_food_description_idx` ON `usda_food` (`description`);--> statement-breakpoint
CREATE INDEX `usda_food_data_type_idx` ON `usda_food` (`data_type`);--> statement-breakpoint
CREATE TABLE `usda_food_nutrient` (
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
CREATE INDEX `food_nutrient_fdc_id` ON `usda_food_nutrient` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `food_nutrient_nutrient_id_idx` ON `usda_food_nutrient` (`nutrient_id`);--> statement-breakpoint
CREATE TABLE `usda_food_portion` (
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
CREATE INDEX `food_portion_fdc_id` ON `usda_food_portion` (`fdc_id`);--> statement-breakpoint
CREATE INDEX `food_portion_measure_unit_id_idx` ON `usda_food_portion` (`measure_unit_id`);--> statement-breakpoint
CREATE TABLE `usda_measure_unit` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usda_nutrient` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit_name` text NOT NULL,
	`nutrient_nbr` text,
	`rank` text
);
--> statement-breakpoint
CREATE TABLE `usda_sr_legacy_food` (
	`fdc_id` integer PRIMARY KEY NOT NULL,
	`NDB_number` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usda_sr_legacy_food_NDB_number_unique` ON `usda_sr_legacy_food` (`NDB_number`);