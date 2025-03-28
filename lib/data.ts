import Fuse from "https://esm.sh/fuse.js@7.0.0";

import optionsDataSummary from "./../data/options-data.summary.json" with {
    type: "json",
};

import optionsSnapshotSummary from "./../data/options-snapshot.summary.json" with {
    type: "json",
};

import cboeOptionsSummary from "./../data/cboe-options-summary.json" with {
    type: "json",
};

import symbols from "./../data/symbols.json" with {
    type: "json",
};

type OptionsDataSummary = Record<string, {
    displayName: string;
    created: Date | string;
    symbols: Record<string, {
        fileName: string;
        assetUrl: string;
    }>;
}>;

type OptionsSnapshotSummaryFileType = {
    hdFileName: string;
    hdAssetUrl: string;
    sdFileName: string;
    sdAssetUrl: string;
};
type OptionsSnapshotSummary = Record<string, {
    displayName: string;
    created: Date | string;
    symbols: Record<string, {
        "gex": OptionsSnapshotSummaryFileType;
        "dex": OptionsSnapshotSummaryFileType;
    }>;
}>;

type CboeOptionSummaryType = {
    name: string,
    optionsAssetUrl: string
}

type TickerSymbol = { name: string, symbol: string }

export const getOptionsDataSummary = () => {
    return optionsDataSummary as OptionsDataSummary;
};

export const getOptionsSnapshotSummary = () => {
    return optionsSnapshotSummary as OptionsSnapshotSummary;
};

export const OptionsSnapshotSummary = (optionsSnapshotSummary as OptionsSnapshotSummary);



export const OptionsSnapshotSummaryLegacy = Object.fromEntries(Object.keys(OptionsSnapshotSummary).map(j => [OptionsSnapshotSummary[j].displayName, { symbols: OptionsSnapshotSummary[j].symbols }]));

export const mapDataToLegacy = () => {
    const intermediateData = getOptionsDataSummary();
    return Object.keys(intermediateData).flatMap((j) => {
        return Object.keys(intermediateData[j].symbols).map((k) => ({
            symbol: k,
            dt: intermediateData[j].displayName,
        }));
    });
};

export const ghRepoBaseUrl = 'https://github.com/5amclub/mztrading-data/releases/download';

export const cleanSymbol = (symbol: string) => decodeURIComponent(symbol).replace(/\W/g, '');

const allTickerSymbols = symbols as TickerSymbol[]

const fuse = new Fuse(allTickerSymbols, {
    keys: ["symbol", "name"],
    threshold: 0.2,
});

export const searchTicker = (q: string) => {
    const filtered = fuse.search(q, { limit: 25 }).map((x) => x.item);
    return filtered;
}

export const CboeOptionsRawSummary = (cboeOptionsSummary as CboeOptionSummaryType[]).map(({ name, optionsAssetUrl }) => ({ name, optionsAssetUrl, dt: name.replace('CBOE_OPTIONS_DATA_', '').substring(0, 10) }));