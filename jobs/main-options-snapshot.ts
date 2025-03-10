import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { format } from "https://deno.land/std@0.224.0/datetime/format.ts";
import puppeteer, { Page } from "https://deno.land/x/puppeteer@16.2.0/mod.ts";
import pretry from "https://esm.sh/p-retry@6.2.1";
import pMap from "https://esm.sh/p-map@7.0.3";
import { chunk } from "jsr:@std/collections";

const maxBatches = 10;

import { getOptionsDataSummary, getOptionsSnapshotSummary, ghRepoBaseUrl, cleanSymbol } from "../lib/data.ts";
import { TRADINGVIEW_BASE_URI } from "../main.ts";
const dataFolder = `temp/options-snapshots`;
await ensureDir(dataFolder);
const data = getOptionsSnapshotSummary();

const timeoutInMS = 3000;
const releaseName = Deno.env.get("RELEASE_NAME") ||
    `DEX_GEX_SNAPSHOT_${format(new Date(), "yyyy-MM-dd")}`;
data[releaseName] = {
    displayName: format(new Date(), "yyyy-MM-dd"),
    created: new Date(),
    symbols: {},
};
const currentRelease = data[releaseName];

const dataSummary = getOptionsDataSummary()
const latestObject = Object.keys(dataSummary).pop() || '';
const latestDate = dataSummary[latestObject].displayName;
let totalSymbols = 0;
let processingCounter = 0;
if (latestDate) {
    const allSymbols = Object.keys(dataSummary[latestObject].symbols);//.slice(0, 30); //for testing work only with 3 items
    console.log(`Found ${allSymbols.length} tickers...`);
    totalSymbols = allSymbols.length;

    const batches = chunk(allSymbols, maxBatches);
    await pMap(batches, processBatch, {
        concurrency: maxBatches
    });

    console.log(`Finished generating snapshot files!`);

    Deno.writeTextFileSync(
        "./data/options-snapshot.summary.json",
        JSON.stringify(data, null, 2),
    );

    console.log(`Summary file generated successfully!`);
} else {
    console.log(`Unable to find any latest date in the data summary file!`);
}

async function processBatch(batchSymbols: string[]) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(
        `${TRADINGVIEW_BASE_URI}/tools/snapshot?showDexGex=true&dgextab=DEX&print=true&datamode=${encodeURIComponent(latestDate)}`,
        {
            waitUntil: "networkidle2",
        },
    ); // replace


    for (const symbol of batchSymbols) {
        await pretry(async (n: number) => {
            if (n > 1) console.log(`Main retry attempt: ${n}`)
            await processSymbol(page, batchSymbols, symbol);
        }, {
            retries: 3
        })
    }
    await browser.close();
}

async function processSymbol(page: Page, allSymbols: string[], symbol: string) {
    const cleanedSymbol = cleanSymbol(symbol)
    
    console.log(`(${++processingCounter}/${totalSymbols}) Fetching dex/gex page for ${symbol}`);

    currentRelease.symbols[symbol] = {
        dex: {
            sdFileName: `${cleanedSymbol}_DEX_620.png`,
            hdFileName: `${cleanedSymbol}_DEX_1240.png`,
            sdAssetUrl: `${ghRepoBaseUrl}/${releaseName}/${cleanedSymbol}_DEX_620.png`,
            hdAssetUrl: `${ghRepoBaseUrl}/${releaseName}/${cleanedSymbol}_DEX_1240.png`
        },
        gex: {
            sdFileName: `${cleanedSymbol}_GEX_620.png`,
            hdFileName: `${cleanedSymbol}_GEX_1240.png`,
            sdAssetUrl: `${ghRepoBaseUrl}/${releaseName}/${cleanedSymbol}_GEX_620.png`,
            hdAssetUrl: `${ghRepoBaseUrl}/${releaseName}/${cleanedSymbol}_GEX_1240.png`
        }
    }

    const currentSymbol = currentRelease.symbols[symbol];

    await page.setViewport({ width: 620, height: 620, deviceScaleFactor: 2 }); // set the viewport size
    let varurlname = `urldex${allSymbols.indexOf(symbol)}${new Date().getTime()}`
    await page.evaluate(`
            let ${varurlname} = new URL(location.href);
            ${varurlname}.searchParams.set("dgextab", "DEX");
            ${varurlname}.searchParams.set("symbol", "${symbol}");
            history.replaceState(null, "", ${varurlname});
        `);

    console.log(`Generating high definition DEX snapshot page for ${symbol}`);

    await page.waitForNetworkIdle({
        timeout: timeoutInMS
    });
    await captureScreenshot(page, `${dataFolder}/${currentSymbol.dex.hdFileName}`); // take a screenshot and save it to a file

    console.log(`Generating standard definition DEX snapshot page for ${symbol}`);
    await page.setViewport({ width: 620, height: 620, deviceScaleFactor: 1 }); // set the viewport size

    await captureScreenshot(page, `${dataFolder}/${currentSymbol.dex.sdFileName}`); // take a screenshot and save it to a file

    varurlname = `urlgex${allSymbols.indexOf(symbol)}${new Date().getTime()}`
    await page.evaluate(`
        let ${varurlname} = new URL(location.href);
        ${varurlname}.searchParams.set("dgextab", "GEX");
        history.replaceState(null, "", ${varurlname});
        `);
    console.log(`Generating standard definition GEX snapshot page for ${symbol}`);

    await captureScreenshot(page, `${dataFolder}/${currentSymbol.gex.sdFileName}`); // take a screenshot and save it to a file

    await page.setViewport({ width: 620, height: 620, deviceScaleFactor: 2 }); // set the viewport size
    console.log(`Generating high definition GEX snapshot page for ${symbol}`);

    await captureScreenshot(page, `${dataFolder}/${currentSymbol.gex.hdFileName}`); // take a screenshot and save it to a file      
}

async function captureScreenshot(page: Page, path: string) {
    await pretry(async (n: number) => {
        if (n > 1) console.log(`Retry attempt: ${n}`)
        await page.waitForNetworkIdle({
            timeout: timeoutInMS
        });
        await page.screenshot({
            path: path
        }); // take a screenshot and save it to a file
    }, {
        retries: 3
    })
}