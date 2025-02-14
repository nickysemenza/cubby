--- xsv search -s serving_size -v '^$' branded_food.csv > branded_food_cleaned.csv
--- removes 10.7k rows
--- 
--- xsv search -s amount -v '^$' food_portion.csv > food_portion_cleaned.csv
--- removes 22K rows

TRUNCATE usda_food cascade;
TRUNCATE usda_nutrient cascade;
TRUNCATE usda_food_nutrient cascade;
TRUNCATE usda_branded_food cascade;
\copy usda_food FROM './food.csv' DELIMITER ',' CSV header;
\copy usda_nutrient FROM './nutrient.csv' DELIMITER ',' CSV header;
\copy usda_food_nutrient FROM './food_nutrient.csv' DELIMITER ',' CSV header;
\copy usda_branded_food FROM './branded_food_cleaned.csv' DELIMITER ',' CSV header;


\copy usda_measure_unit FROM './measure_unit.csv' DELIMITER ',' CSV header;
\copy usda_food_portion FROM './food_portion_cleaned.csv' DELIMITER ',' CSV header;