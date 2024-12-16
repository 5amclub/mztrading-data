import os
import requests
import pandas as pd
import json
from datetime import datetime

import time
from http import HTTPStatus
from requests.exceptions import HTTPError

release_name = os.getenv("RELEASE_NAME", datetime.now().strftime("%Y-%m-%d %H:%M"))

# Function to normalize and extract stock data
def parse_stock_data(data):
    # Extract stock (main) data excluding "options"
    stock_data = {
        "timestamp": data["timestamp"],
        "symbol": data["symbol"],
        **{k: v for k, v in data["data"].items() if k != "options"},  # Exclude "options"
    }
    return stock_data

# Function to normalize and extract options data
def parse_options_data(data):
    options = data["data"]["options"]
    options_df = pd.DataFrame(options)
    options_df["timestamp"] = data["timestamp"]  # Add timestamp
    options_df["symbol"] = data["symbol"]  # Add symbol
    return options_df

# Fetch the list of symbols
watchlist_response = requests.get("https://mztrading.netlify.app/api/watchlist")
watchlist_response.raise_for_status()
watchlist = watchlist_response.json()  # Expected format: { items: [{ symbol: str, name: str }] }

symbols = [item["symbol"] for item in watchlist["items"]]
print(f"Found {len(symbols)} symbols: {symbols}")

# Initialize lists to collect all stock and options data
all_stock_data = []
all_options_data = []
retries = 20
retry_codes = [
    HTTPStatus.TOO_MANY_REQUESTS,
    HTTPStatus.INTERNAL_SERVER_ERROR,
    HTTPStatus.BAD_GATEWAY,
    HTTPStatus.SERVICE_UNAVAILABLE,
    HTTPStatus.GATEWAY_TIMEOUT,
]
# Loop through each symbol and fetch data
for symbol in symbols:
    try:
        for n in range(retries):
            try:
                print(f"Fetching data for symbol: {symbol}...")
                response = requests.get(f"https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json")
                response.raise_for_status()
                json_data = response.json()
                
                # Parse stock and options data
                stock_data = parse_stock_data(json_data)
                options_df = parse_options_data(json_data)
                
                # Add stock data to the list
                all_stock_data.append(stock_data)
                
                # Append options data to the list
                all_options_data.append(options_df)
                break
            except HTTPError as exc:
                code = exc.response.status_code            
                if code in retry_codes:
                    # retry after n seconds
                    print(f"Http error occurred while fetching data for symbol: {symbol}... Sleeping for {n} seconds")
                    time.sleep(n)
                    continue    
                raise
    except Exception as e:
        print(f"Error fetching data for {symbol}: {e}")

# Combine all stock and options data into DataFrames
stock_df = pd.DataFrame(all_stock_data)
options_df = pd.concat(all_options_data, ignore_index=True)

# Save DataFrames to Parquet files
os.makedirs("temp", exist_ok=True)  # Ensure the 'data' folder exists
stock_file = "temp/stock_data.parquet"
options_file = "temp/options_data.parquet"

stock_df.to_parquet(stock_file, index=False)
options_df.to_parquet(options_file, index=False)

print(f"Saved stock data to {stock_file}")
print(f"Saved options data to {options_file}")

# Update JSON summary file
summary_file = "data/cboe-options-summary.json"

# Load existing summary data if the file exists, otherwise start with an empty list
if os.path.exists(summary_file):
    with open(summary_file, "r") as file:
        summary_data = json.load(file)
else:
    summary_data = []

# Add a new record with the current timestamp
summary_data.append({"name": release_name})

# Write updated summary back to the JSON file
with open(summary_file, "w") as file:
    json.dump(summary_data, file, indent=4)

print(f"Updated summary file: {summary_file}")