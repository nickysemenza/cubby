#!/bin/bash

# Script to connect to PostgreSQL and load USDA data
# Usage: Run this script from the USDA CSV data directory
# Example: cd /path/to/usda/data && /path/to/recipehub/tooling/load_usda_data.sh

set -e  # Exit on any error

DB_URL="postgresql://recipehub:example@localhost:5555/recipes"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/usda_load.sql"

echo "Connecting to database: $DB_URL"
echo "Running from directory: $(pwd)"
echo "Running SQL script: $SQL_FILE"

# Connect to PostgreSQL and run the SQL file
psql "$DB_URL" -f "$SQL_FILE"

echo "USDA data loading completed successfully!"