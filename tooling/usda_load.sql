TRUNCATE usda_food cascade;
TRUNCATE usda_nutrient cascade;
TRUNCATE usda_food_nutrient cascade;
TRUNCATE usda_branded_food cascade;
\copy usda_food FROM './food.csv' DELIMITER ',' CSV header;
\copy usda_nutrient FROM './nutrient.csv' DELIMITER ',' CSV header;
\copy usda_food_nutrient FROM './food_nutrient.csv' DELIMITER ',' CSV header;
---xsv search -s serving_size -v '^$' branded_food.csv > branded_food_cleaned.csv
--- removes removes 10.7k rows, and header
\copy usda_branded_food FROM './branded_food_cleaned.csv' DELIMITER ',' CSV header;