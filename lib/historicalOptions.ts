
// @deno-types="https://esm.sh/v135/@duckdb/duckdb-wasm@1.28.0/dist/duckdb-browser-blocking.d.ts"
import { createDuckDB, getJsDelivrBundles, ConsoleLogger, DEFAULT_RUNTIME } from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/dist/duckdb-browser-blocking.mjs/+esm';

import optionsRollingSummary from "./../data/cboe-options-rolling.json" with {
    type: "json",
};
import { getPriceAtDate } from './historicalPrice.ts';
import dayjs from "https://esm.sh/dayjs@1.11.13";
import { getOptionsChain } from './cboe.ts';

const logger = new ConsoleLogger();
const JSDELIVR_BUNDLES = getJsDelivrBundles();

const initialize = async () => {
    const { assetUrl, name } = optionsRollingSummary;
    // const ds = 'https://github.com/5amclub/mztrading-data/releases/download/archives/output_test_all.parquet';

    //HTTP paths are not supported due to xhr not available in deno.
    //db.registerFileURL('db.parquet', assetUrl, DuckDBDataProtocol.HTTP, false);

    console.log(`initializing duckdb with ${assetUrl} and name: ${name}`);
    const db = await createDuckDB(JSDELIVR_BUNDLES, logger, DEFAULT_RUNTIME);
    await db.instantiate(() => { });
    const arrayBuffer = await fetch(assetUrl)    //let's initialize the data set in memory
        .then(r => r.arrayBuffer());
    db.registerFileBuffer('db.parquet', new Uint8Array(arrayBuffer));
    return db;
}

const dbPromise = initialize();

export const getConnection = async () => {
    const dbPromiseVal = await dbPromise;
    return dbPromiseVal.connect();
}

//find a way to parametrize the query
export const getHistoricalSnapshotDatesFromParquet = async (symbol: string) => {
    const conn = await getConnection();
    const arrowResult = await conn.send(`SELECT DISTINCT CAST(dt as STRING) as dt FROM 'db.parquet' WHERE option_symbol = '${symbol.toUpperCase()}'`);
    return arrowResult.readAll().flatMap(k => k.toArray().map((row) => row.toJSON()));
}

//find a way to parametrize the query
export const getHistoricalSnapshotDates = async () => {
    const conn = await getConnection();
    const arrowResult = await conn.send(`SELECT DISTINCT CAST(dt as STRING) as dt FROM 'db.parquet'`);
    return arrowResult.readAll().flatMap(k => k.toArray().map((row) => row.toJSON()));
}

export const getHistoricalOptionDataFromParquet = async (symbol: string, dt: string) => {
    const conn = await getConnection();
    const arrowResult = await conn.send(`SELECT cast(expiration as string) as expiration, delta, option_type, gamma, cast(strike as string) strike, open_interest, volume 
            FROM 'db.parquet' 
            WHERE option_symbol = '${symbol.toUpperCase()}' 
            AND dt = '${dt}'`);
    return arrowResult.readAll().flatMap(k => k.toArray().map((row) => row.toJSON())) as { expiration: string, delta: number, gamma: number, option_type: 'C' | 'P', strike: string, open_interest: number, volume: number }[];
}

export const getHistoricalGreeksSummaryDataFromParquet = async (dt: string, dte: number | undefined) => {
    const conn = await getConnection();
    const dteFilterExpression = dte ? `AND expiration < date_add(dt, INTERVAL ${dte} DAYS)` : '';  //revisit it to get clarity on adding/subtracting days
    const arrowResult = await conn.send(`
            SELECT
                option_symbol,
                round(SUM(IF(option_type = 'C', open_interest * delta, 0))) as call_delta,
                round(SUM(IF(option_type = 'P', open_interest * abs(delta), 0))) as put_delta,
                round(SUM(IF(option_type = 'C', open_interest * gamma, 0))) as call_gamma,
                round(SUM(IF(option_type = 'P', open_interest * gamma, 0))) as put_gamma,
                round(SUM(IF(option_type = 'C', open_interest, 0))) as call_oi,
                round(SUM(IF(option_type = 'P', open_interest, 0))) as put_oi,
                round(SUM(IF(option_type = 'C', volume, 0))) as call_volume,
                round(SUM(IF(option_type = 'P', volume, 0))) as put_volume,
                call_delta/put_delta as call_put_dex_ratio,
                call_gamma-put_gamma as net_gamma,
                call_oi/put_oi as call_put_oi_ratio,
                call_volume/put_volume as call_put_volume_ratio
            FROM 'db.parquet' 
            WHERE dt = '${dt}'
            ${dteFilterExpression}
            GROUP BY option_symbol
        `);
    return arrowResult.readAll().flatMap(k => k.toArray().map((row) => row.toJSON())) as {
        option_symbol: string, call_delta: number, put_delta: number, call_gamma: number, put_gamma: number, call_oi: number,
        put_oi: number, call_volume: number, put_volume: number, call_put_dex_ratio: number, net_gamma: number, call_put_oi_ratio: number, call_put_volume_ratio: number
    }[];
}

export const lastHistoricalOptionDataFromParquet = () => {
    return optionsRollingSummary;
}

type MicroOptionPricingItem = { oi: number, b: number, a: number, v: number, l: number }
type MicroOptionPricingContract = { c: Record<string, MicroOptionPricingItem>, p: Record<string, MicroOptionPricingItem> }

type MicroOptionContractItem = { oi: number, volume: number, delta: number, gamma: number, iv: number, vega: number, theta: number }
type MicroOptionContract = { call: MicroOptionContractItem, put: MicroOptionContractItem }
type ExposureDataItem = { absDelta: number[], absGamma: number[], openInterest: number[], volume: number[], iv: number[], vega: number[], theta: number[] }
type ExposureDataType = { call: ExposureDataItem, put: ExposureDataItem, netGamma: number[], strikes: string[], expiration: string, dte: number }

export type ExposureDataRequest = { data: Record<string, Record<string, MicroOptionContract>>, spotPrice: number, spotDate: string }

export const getExposureData = async (symbol: string, dt: string | 'LIVE') => {
    const spotDate = (dt == 'LIVE' ? dayjs() : dayjs(dt)).format('YYYY-MM-DD');
    const { spotPrice, indexedObject } = dt == 'LIVE' ? await getLiveCboeOptionData(symbol) : await getHistoricalOptionData(symbol, dt);

    return calculateExpsoure(spotPrice, indexedObject, spotDate);
}

export const calculateExpsoure = (spotPrice: number, indexedObject: Record<string, Record<string, MicroOptionContract>>, spotDate: string) => {
    const dataToPersist = {
        data: [] as ExposureDataType[],
        spotPrice: spotPrice
    };

    const expirations = Object.keys(indexedObject);
    const callWallMap = {} as Record<string, number>;
    const putWallMap = {} as Record<string, number>;

    for (const expiration of expirations) {
        const dte = dayjs(expiration).diff(spotDate, 'day');
        if (dte < 0) continue; //skip if expiration is in the past
        const strikes = Object.keys(indexedObject[expiration]);

        const callThetaData = new Array<number>(strikes.length).fill(0);
        const putThetaData = new Array<number>(strikes.length).fill(0);

        const callVegaData = new Array<number>(strikes.length).fill(0);
        const putVegaData = new Array<number>(strikes.length).fill(0);

        const callImpliedVolatilityData = new Array<number>(strikes.length).fill(0);
        const putImpliedVolatilityData = new Array<number>(strikes.length).fill(0);

        const callOpenInterestData = new Array<number>(strikes.length).fill(0);
        const putOpenInterestData = new Array<number>(strikes.length).fill(0);

        const callVolumeData = new Array<number>(strikes.length).fill(0);
        const putVolumeData = new Array<number>(strikes.length).fill(0);

        const callDeltaData = new Array<number>(strikes.length).fill(0);
        const putDeltaData = new Array<number>(strikes.length).fill(0);

        const callGammaData = new Array<number>(strikes.length).fill(0);
        const putGammaData = new Array<number>(strikes.length).fill(0);

        const netGammaData = new Array<number>(strikes.length).fill(0);

        for (let ix = 0; ix < strikes.length; ix++) {

            callOpenInterestData[ix] = (indexedObject[expiration][strikes[ix]]?.call?.oi || 0);
            putOpenInterestData[ix] = indexedObject[expiration][strikes[ix]]?.put?.oi || 0;

            callVolumeData[ix] = (indexedObject[expiration][strikes[ix]]?.call?.volume || 0);
            putVolumeData[ix] = indexedObject[expiration][strikes[ix]]?.put?.volume || 0;

            callThetaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.call.theta || 0) * 100 * callOpenInterestData[ix] * spotPrice);
            putThetaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.put.theta || 0) * 100 * putOpenInterestData[ix] * spotPrice);

            callVegaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.call.vega || 0) * 100 * callOpenInterestData[ix] * spotPrice);
            putVegaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.put.vega || 0) * 100 * putOpenInterestData[ix] * spotPrice);

            callImpliedVolatilityData[ix] = indexedObject[expiration][strikes[ix]]?.call.iv || 0;
            putImpliedVolatilityData[ix] = indexedObject[expiration][strikes[ix]]?.put.iv || 0;

            callDeltaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.call?.delta || 0) * 100 * callOpenInterestData[ix] * spotPrice);
            putDeltaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.put?.delta || 0) * 100 * putOpenInterestData[ix] * spotPrice);

            callGammaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.call?.gamma || 0) * 100 * callOpenInterestData[ix] * spotPrice);
            putGammaData[ix] = Math.trunc((indexedObject[expiration][strikes[ix]]?.put?.gamma || 0) * 100 * putOpenInterestData[ix] * spotPrice);

            const callGamma = (indexedObject[expiration][strikes[ix]]?.call?.gamma || 0) * 100 * callOpenInterestData[ix] * spotPrice;
            const putGamma = (indexedObject[expiration][strikes[ix]]?.put?.gamma || 0) * 100 * putOpenInterestData[ix] * spotPrice;
            netGammaData[ix] = Math.trunc(callGamma - putGamma);

            const strikePrice = Number(strikes[ix])
            callWallMap[strikePrice] = (callWallMap[strikePrice] || 0) + callGamma;
            putWallMap[strikePrice] = (putWallMap[strikePrice] || 0) + putGamma;
        }

        dataToPersist.data.push({
            call: {
                absDelta: callDeltaData,
                absGamma: callGammaData,
                openInterest: callOpenInterestData,
                volume: callVolumeData,
                iv: callImpliedVolatilityData,
                vega: callVegaData,
                theta: callThetaData
            },
            put: {
                absDelta: putDeltaData,
                absGamma: putGammaData,
                openInterest: putOpenInterestData,
                volume: putVolumeData,
                iv: putImpliedVolatilityData,
                vega: putVegaData,
                theta: putThetaData
            },
            netGamma: netGammaData,
            strikes: strikes,
            expiration,
            dte: dte
        });
    }

    // dataToPersist.callWall = Object.keys(callWallMap).reduce((a, b) => callWallMap[a] > callWallMap[b] ? a : b);
    // dataToPersist.putWall = Object.keys(putWallMap).reduce((a, b) => putWallMap[a] > putWallMap[b] ? a : b);

    // dataToPersist['cw'] = callWallMap;
    // dataToPersist['pw'] = putWallMap;

    dataToPersist.data.sort((a, b) => a.dte - b.dte);
    return dataToPersist;
}

async function getHistoricalOptionData(symbol: string, dt: string) {
    console.time(`getHistoricalOptionData-${symbol}-${dt}`)
    const historicalData = await getHistoricalOptionDataFromParquet(symbol, dt);
    const indexedObject = historicalData.reduce((previous, current) => {
        previous[current.expiration] = previous[current.expiration] || {};
        previous[current.expiration][current.strike] = previous[current.expiration][current.strike] || {};
        //does it make sense to throw exception if delta/gamma values doesn't seem accurate? like gamma being negative or delta being greater than 1?
        if (current.option_type == 'C') {
            previous[current.expiration][current.strike].call = { oi: current.open_interest, volume: current.volume, delta: current.delta, gamma: current.gamma, iv: current.iv, vega: current.vega, theta: current.theta };
        } else if (current.option_type == 'P') {
            previous[current.expiration][current.strike].put = { oi: current.open_interest, volume: current.volume, delta: current.delta, gamma: current.gamma, iv: current.iv, vega: current.vega, theta: current.theta };
        } else {
            throw new Error("Invalid option type");
        }
        return previous;
    }, {} as Record<string, Record<string, MicroOptionContract>>);
    console.timeEnd(`getHistoricalOptionData-${symbol}-${dt}`)

    const _spotPrice = await getPriceAtDate(symbol, dt, true);
    if (!_spotPrice || Number.isNaN(_spotPrice)) throw new Error("Invalid spot price");
    const spotPrice = Number(_spotPrice);
    return { spotPrice, indexedObject };
}

async function getLiveCboeOptionData(symbol: string) {
    const { data, currentPrice } = await getOptionsChain(symbol);
    const indexedObject = data.reduce((previous, current) => {
        previous[current.expiration] = previous[current.expiration] || {};
        previous[current.expiration][current.strike] = previous[current.expiration][current.strike] || {};
        //does it make sense to throw exception if delta/gamma values doesn't seem accurate? like gamma being negative or delta being greater than 1?
        if (current.option_type == 'C') {
            previous[current.expiration][current.strike].call = { oi: current.open_interest, volume: current.volume, delta: current.delta, gamma: current.gamma, iv: current.iv, vega: current.vega, theta: current.theta };
        } else if (current.option_type == 'P') {
            previous[current.expiration][current.strike].put = { oi: current.open_interest, volume: current.volume, delta: current.delta, gamma: current.gamma, iv: current.iv, vega: current.vega, theta: current.theta };
        } else {
            throw new Error("Invalid option type");
        }
        return previous;
    }, {} as Record<string, Record<string, MicroOptionContract>>);
    return { spotPrice: currentPrice, indexedObject };
}

export async function getLiveCboeOptionsPricingData(symbol: string) {
    const { data, currentPrice } = await getOptionsChain(symbol);
    const options = data.reduce((previous, current) => {
        previous[current.expiration] = previous[current.expiration] || { c: {}, p: {} };
        if (current.option_type == 'C') {
            previous[current.expiration].c[current.strike] = { oi: current.open_interest, v: current.volume, l: current.last_trade_price, a: current.ask, b: current.bid };
        } else if (current.option_type == 'P') {
            previous[current.expiration].p[current.strike] = { oi: current.open_interest, v: current.volume, l: current.last_trade_price, a: current.ask, b: current.bid };
        } else {
            throw new Error("Invalid option type");
        }
        return previous;
    }, {} as Record<string, MicroOptionPricingContract>);
    return { spotPrice: currentPrice, options };
}