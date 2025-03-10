import {
    Application,
    isHttpError,
    Router,
} from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { sortBy } from "https://deno.land/std@0.224.0/collections/sort_by.ts";
import { getQuery } from "https://deno.land/x/oak@v12.6.1/helpers.ts";
import ky from "https://esm.sh/ky@1.2.3";
import {
    CboeOptionsRawSummary,
    getOptionsDataSummary,
    mapDataToLegacy,
    OptionsSnapshotSummary,
    OptionsSnapshotSummaryLegacy,
    searchTicker,
} from "./lib/data.ts";

import { getPriceAtDate } from './lib/historicalPrice.ts'
import { calculateExpsoure, ExposureDataRequest, getExposureData, getHistoricalGreeksSummaryDataFromParquet, getHistoricalOptionDataFromParquet, getHistoricalSnapshotDatesFromParquet, lastHistoricalOptionDataFromParquet, getLiveCboeOptionsPricingData, getHistoricalSnapshotDates } from "./lib/historicalOptions.ts";
import { getOptionsAnalytics, getOptionsChain } from "./lib/cboe.ts";
import { getIndicatorValues } from "./lib/ta.ts";

const token = Deno.env.get("ghtoken");
const router = new Router();

export const TRADINGVIEW_BASE_URI = "https://mytradingview.vercel.app/"

const getHistoricalOptionsData = async (s: string, dt: string) => {
    const memData = getOptionsDataSummary();
    const assetUrl = Object.values(memData).find((j) => j.displayName == dt)
        ?.symbols[s.toUpperCase()].assetUrl;
    if (assetUrl) {
        return await ky(assetUrl).json();
    }

    const data = await ky(
        `https://raw.githubusercontent.com/5amclub/mytradingview-data/main/data/dt=${dt}/symbol=${s.toUpperCase()}/data.json`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        },
    ).json();
    return data;
};

router.get("/", (context) => {
    context.response.body = "hello";
})
    .get("/releases", async (context) => {
        const newReleases = Object.values(OptionsSnapshotSummary).map((j) => ({
            name: j.displayName,
        })).reverse();
        const releases = await ky(
            `https://api.github.com/repos/5amclub/mytradingview-data/tags`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        ).json<{ name: string }[]>();

        const finalResponse = [...newReleases, ...releases].map((j) => ({
            name: j.name,
        }));
        context.response.body = finalResponse;
        context.response.type = "application/json";
    })
    .get("/beta/optionsdatasummary", (context) => {
        const data = getOptionsDataSummary();
        context.response.body = Object.keys(data).map((j) => ({
            name: j,
            displayName: data[j].displayName,
        }));
    })
    .get("/beta/optionsdata", async (context) => {
        const { s, r } = getQuery(context);
        const data = getOptionsDataSummary();
        const { assetUrl } = data[r].symbols[s];
        console.log(`making http call to access: ${assetUrl}`);
        const assetData = await ky(assetUrl).json<{}>();
        context.response.body = assetData;
        context.response.type = "application/json";
    })
    .get("/summary", async (context) => {
        const { s } = getQuery(context);
        const data = await ky(
            `https://raw.githubusercontent.com/5amclub/mytradingview-data/main/summary/data.json`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        ).json<{ symbol: string; dt: string }[]>();
        const newReleaseData = mapDataToLegacy();

        const mergedDataset = [...data, ...newReleaseData];

        const filteredData = s
            ? mergedDataset.filter((j) =>
                j.symbol.toUpperCase() == s.toUpperCase()
            )
            : mergedDataset;

        const sortedByDates = sortBy(filteredData, (it) => it.dt, {
            order: "desc",
        });

        context.response.body = sortedByDates;
        context.response.type = "application/json";
    })
    .get("/data", async (context) => {
        const { dt, s } = getQuery(context);
        if (!dt || !s) {
            throw new Error(
                `empty query provided. Use with ?dt=YOUR_QUERY&s=aapl`,
            );
        }
        // const cu = await yf.historical(s, {
        //     period1: dayjs(dt.substr(0, 10)).toDate(),
        //     interval: '1d',
        //     period2: dayjs(dt.substr(0, 10)).add(1, 'days').toDate()
        // })
        // const currentPrice = cu.at(0)?.open;

        const data = await getHistoricalOptionsData(s, dt);
        const priceAtDate = await getPriceAtDate(s, dt)
        context.response.body = { data, price: priceAtDate };
        context.response.type = "application/json";
    })
    .get("/symbols", (context) => {
        //api/symbols/search?q=t
        const { q } = getQuery(context);
        const items = searchTicker(q);
        context.response.body = items;
    })
    .get("/symbols/:symbol/historical/snapshots", (context) => {
        const { symbol } = context.params;
        const result = Object.keys(OptionsSnapshotSummaryLegacy)
            .filter((j) =>
                Object.keys(OptionsSnapshotSummaryLegacy[j].symbols).includes(
                    symbol,
                )
            )
            .map((k) => ({ date: k, data: OptionsSnapshotSummaryLegacy[k].symbols[symbol] }))
            .map(({ data, date }) => ({
                date: date,
                dex: {
                    hdAssetUrl: data.dex.hdAssetUrl,
                    sdAssetUrl: data.dex.sdAssetUrl
                },
                gex: {
                    hdAssetUrl: data.gex.hdAssetUrl,
                    sdAssetUrl: data.gex.sdAssetUrl
                },
            }));
        context.response.body = { items: result };
        context.response.type = "application/json";
    })
    .get("/images", async (context) => {
        console.log(`getting image`);
        const { dt, s } = getQuery(context);
        if (!dt || !s) {
            throw new Error(
                `empty query provided. Use with ?dt=YOUR_QUERY&s=aapl`,
            );
        }

        // console.log(`finding ${dt} in ${JSON.stringify(Object.keys(OptionsSnapshotSummaryLegacy))}`);
        if (Object.keys(OptionsSnapshotSummaryLegacy).includes(dt)) {
            const u =
                OptionsSnapshotSummaryLegacy[dt].symbols[s].dex.hdAssetUrl;

            //console.log(`asset url found: ${u}`);

            const { headers, status } = await ky.head(u, {
                redirect: "manual",
                throwHttpErrors: false,
            });
            if (status < 400) {
                const s3Location = headers.get("location");
                if (s3Location) {
                    context.response.redirect(s3Location);
                } else {
                    throw new Error("empty s3 location received!");
                }
            } else {
                throw new Error("error loading image!");
            }

            //context.response.redirect(OptionsSnapshotSummaryLegacy[dt].symbols[s].dex.hdAssetUrl);

            // const {headers} = await ky.head(OptionsSnapshotSummaryLegacy[dt].symbols[s].dex.hdAssetUrl, { redirect: 'manual' });
            // const s3Location = headers.get('location');
            // if(s3Location) {
            //     context.response.redirect(s3Location);
            // }

            // const data = await ky(OptionsSnapshotSummaryLegacy[dt].symbols[s].dex.hdAssetUrl).blob();
            // context.response.body = data;
            // context.response.type = "image/png";
        } else {
            // console.log(
            // `calling endpoint: https://api.github.com/repos/5amclub/mytradingview-data/releases/tags/${
            //     dt.substring(0, 10)
            //     }`,
            // );
            const { assets } = await ky(
                `https://api.github.com/repos/5amclub/mytradingview-data/releases/tags/${dt.substring(0, 10)
                }`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
            ).json<{ assets: { url: string; name: string }[] }>();
            const url = assets.find((j) => j.name == `${s.toUpperCase()}.png`)
                ?.url;
            if (!url) throw new Error("no asset found");
            const data = await ky(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/octet-stream",
                },
            }).blob();
            context.response.body = data;
            context.response.type = "image/png";
        }
    })
    .get("/legacy/releases", async (context) => {
        const releases = await ky(
            `https://api.github.com/repos/5amclub/mytradingview-data/tags`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        ).json<{ name: string }[]>();
        context.response.body = releases.map((j) => ({ name: j.name }));
        context.response.type = "application/json";
    })
    .get("/releases/symbols", async (context) => {
        const { r } = getQuery(context);
        const symbols: string[] = [];
        if (Object.keys(OptionsSnapshotSummaryLegacy).includes(r)) {
            symbols.push(
                ...Object.keys(OptionsSnapshotSummaryLegacy[r].symbols),
            );
        } else {
            const { assets } = await ky(
                `https://api.github.com/repos/5amclub/mytradingview-data/releases/tags/${r}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
            ).json<{ assets: { url: string; name: string }[] }>();
            symbols.push(...assets.map((j) => j.name.split(".").at(0) || ""));
        }
        context.response.body = symbols.sort().map((j) => ({ name: j }));
        context.response.type = "application/json";
    })
    .get("/beta/historical/cboesummary", (context) => {        //make the resource name more appropriate
        context.response.body = CboeOptionsRawSummary;
        context.response.type = "application/json";
    })
    .get("/beta/symbols/:symbol/historical/snapshots", async (context) => {        //make the resource name more appropriate
        const { symbol } = context.params;
        context.response.body = await getHistoricalSnapshotDatesFromParquet(symbol);
        context.response.type = "application/json";
    })
    .get("/beta/symbols/:symbol/historical/snapshots/:dt", async (context) => {        //make the resource name more appropriate
        const { symbol, dt } = context.params;
        context.response.body = await getHistoricalOptionDataFromParquet(symbol, dt);
        context.response.type = "application/json";
    })
    .get("/beta/misc/last30rolling.parquet", (context) => {        //make the resource name more appropriate
        const { assetUrl } = lastHistoricalOptionDataFromParquet();
        context.response.redirect(assetUrl);
    })
    .get("/beta/symbols/:symbol/cboeoptionchain", async (context) => {        //make the resource name more appropriate
        const { symbol } = context.params;
        const data = await getOptionsChain(symbol);
        context.response.body = data;
        context.response.type = "application/json";
    })
    .get("/beta/cboeoptionchainanalytics", async (context) => {        //make the resource name more appropriate
        const data = await getOptionsAnalytics();
        context.response.body = data;
        context.response.type = "application/json";
    })
    .get("/beta/symbols/:symbol/historical/snapshots/:dt/exposure", async (context) => {
        const { symbol, dt } = context.params;
        context.response.body = await getExposureData(symbol, dt);
        context.response.type = "application/json";
    })
    .get("/beta/reports/optionsgreekssummary", async (context) => {
        const { dt, dte } = getQuery(context);
        if (!dt) throw new Error("dt parameter is missing!");
        context.response.body = await getHistoricalGreeksSummaryDataFromParquet(dt, dte);
        context.response.type = "application/json";
    })
    .get("/beta/symbols/:symbol/exposure", async (context) => {
        const { symbol } = context.params;
        context.response.body = await getExposureData(symbol, 'LIVE');
        context.response.type = "application/json";
    })
    .get("/beta/symbols/:symbol/optionspricing", async (context) => {
        const { symbol } = context.params;
        context.response.body = await getLiveCboeOptionsPricingData(symbol);
        context.response.type = "application/json";
    })
    .post("/beta/tools/exposure", async (context) => {
        if (!context.request.hasBody) {
            context.throw(415);
        }
        const { data, spotPrice, spotDate } = await context.request.body().value as ExposureDataRequest;
        context.response.body = calculateExpsoure(spotPrice, data, spotDate);
        context.response.type = "application/json";
    })
    .get("/symbols/:symbol/indicators", async (context) => {
        const { symbol } = context.params;
        const { q } = getQuery(context);
        const indicators = q.split(',');

        context.response.body = await getIndicatorValues(symbol, indicators)
        context.response.type = "application/json";
    })
    .get("/api/options/exposures/dates", async (context) => {
        context.response.body = await getHistoricalSnapshotDates();
        context.response.type = "application/json";
    });

const app = new Application();

app.use(async (context, next) => {
    try {
        context.response.headers.set("Access-Control-Allow-Origin", "*");
        await next();
    } catch (err) {
        if (isHttpError(err)) {
            context.response.status = err.status;
        } else {
            context.response.status = 500;
        }
        context.response.body = { error: err.message };
        context.response.type = "json";
    }
});

app.use(router.routes());
app.use(router.allowedMethods());
await app.listen({ port: 30196 });
