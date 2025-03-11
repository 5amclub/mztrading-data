import json
import os
import duckdb
import re
import pandas as pd
from datetime import datetime
file_path = './data/cboe-options-summary.json'

release_name = os.getenv("RELEASE_NAME", datetime.now().strftime("%Y-%m-%d %H:%M"))

with open(file_path, 'r') as file:
    data = json.load(file)

# Extract all optionsAssetUrl and name values
options_data = [(item['optionsAssetUrl'], item['name']) for item in data if 'optionsAssetUrl' in item and 'name' in item]

# Take the last 30 entries
last_30_entries = options_data[-30:]

duckdb.sql(f"""CREATE OR REPLACE TABLE OPDATA (dt DATE, option string, option_symbol string, expiration string, option_type string, strike float, open_interest int, volume int, delta float, gamma float)""")

# Print the extracted data
for optionsAssetUrl, name in last_30_entries:
  print(f"Name: {name}, URL: {optionsAssetUrl}")
  match = re.search(r'\d{4}-\d{2}-\d{2}', name)
  if match:
    date_str = match.group()
    date = datetime.strptime(date_str, '%Y-%m-%d').date()
    print(f"Parsed Date: {date}")
    
    duckdb.sql(f"""INSERT INTO OPDATA SELECT '{date}' AS dt, option, UNNEST(regexp_extract(option, '(\w+)(\d{{6}})([CP])(\d+)', ['option_symbol', 'expiration', 'option_type', 'strike'])), open_interest, volume, delta,gamma fROM read_parquet('{optionsAssetUrl}')""")
  else:
    raise ValueError(f"Unable to parse date from name: {name}")
  
duckdb.sql("UPDATE OPDATA SET strike = strike/1000, expiration='20'|| expiration")

os.makedirs("temp", exist_ok=True)  # Ensure the 'data' folder exists
output_file = "temp/options_cboe_rolling_30.parquet" #let see if 30 days we can handle, since deno has a limit of memory. 10 days worth is 30MB, so 30 days should be 90MB.

duckdb.sql(f"""COPY (select dt, option_symbol, CAST(strptime(expiration, '%Y%m%d') as date) expiration, delta, gamma, option_type, strike, open_interest, volume  from OPDATA) to '{output_file}' (FORMAT PARQUET)""")

# Let's use some magic of parquet compression.
df = pd.read_parquet(output_file)
df = df.sort_values(by=['option_symbol', 'dt', 'expiration', 'option_type'])
df.to_parquet(output_file, compression='zstd', index=False)

# Get the file size in bytes
file_size_bytes = os.path.getsize(output_file)
file_size_mb = file_size_bytes / (1024 * 1024)
print(f"File size after compression: {file_size_mb:.2f} MB")


summary_file = "data/cboe-options-rolling.json"
# Write updated summary back to the JSON file
with open(summary_file, "w") as file:
    json.dump({"name": release_name, "assetUrl":f"https://github.com/mnsrulz/mztrading-data/releases/download/{release_name}/options_cboe_rolling_30.parquet"}, file, indent=4)

print(f"Updated summary file: {summary_file}")
