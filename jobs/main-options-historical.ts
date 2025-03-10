import ky from "https://esm.sh/ky@1.2.3";
import { format } from "https://deno.land/std@0.224.0/datetime/format.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { getOptionsDataSummary, cleanSymbol } from "../lib/data.ts";
import { TRADINGVIEW_BASE_URI } from "../main.ts";
const tickers = await ky(`${TRADINGVIEW_BASE_URI}/api/watchlist`).json<
    { items: { symbol: string; name: string }[] }
>();

console.log(`found ${tickers.items.length} tickers...`);
const items = tickers.items; //.slice(0, 3); //for testing work only with 3 items
const dataFolder = `temp/options-historical`;
const data = getOptionsDataSummary();
const releaseName = Deno.env.get("RELEASE_NAME") ||
    `OPTIONS_DATA_${format(new Date(), "yyyy-MM-dd HH:mm")}`;
data[releaseName] = {
    displayName: format(new Date(), "yyyy-MM-dd HH:mm"),
    created: new Date(),
    symbols: {},
};
await ensureDir(dataFolder);
for (const ticker of items) {
    const { symbol } = ticker;
    const cleanedSymbol = cleanSymbol(symbol)
    try {
        console.log(`Processing ticker: ${symbol}`);
        const fileName = `${cleanedSymbol}.json`;
        const { raw } = await ky(`${TRADINGVIEW_BASE_URI}/api/symbols/${symbol}/options/analyze/tradier?dte=90&sc=30`).json<{ raw: any }>();
        await Deno.writeTextFile(
            `${dataFolder}/${fileName}`,
            JSON.stringify(raw),
        ); //it'll overwrite if it already exists
        data[releaseName].symbols[symbol] = {
            fileName: fileName,
            assetUrl:
                `https://github.com/5amclub/mztrading-data/releases/download/${releaseName}/${fileName}`,
        };
    } catch (error) {
        console.log(`error occurred while loading data for symbol: ${symbol}`);
    }
}

console.log(`Finished generating data files!`);

Deno.writeTextFileSync(
    "./data/options-data.summary.json",
    JSON.stringify(data, null, 2),
);

console.log(`Summary file generated successfully!`);
