// Bitcoin market context: sentiment, dominance and network figures. All free, no key.
import { getJson, num } from "./http.js";

export const feargreed = {
  id: "feargreed",
  name: "Fear & Greed (alternative.me)",
  kind: "btcextra",
  needsKey: false,
  defaultEnabled: true,
  site: "https://alternative.me/crypto/fear-and-greed-index/",
  note: "Daily crypto sentiment index, 0 (extreme fear) to 100 (extreme greed), with 30 days of history.",
  async fetch() {
    const d = await getJson("https://api.alternative.me/fng/?limit=30", { provider: "feargreed" });
    const rows = (d.data || []).map((r) => ({ value: num(r.value), label: r.value_classification, at: new Date(Number(r.timestamp) * 1000).toISOString() }));
    if (!rows.length) throw new Error("Fear & Greed: empty answer");
    return { fearGreed: { ...rows[0], history: rows.slice().reverse().map((r) => [Date.parse(r.at), r.value]) } };
  },
};

export const cgglobal = {
  id: "cgglobal",
  name: "CoinGecko global",
  kind: "btcextra",
  needsKey: false,
  defaultEnabled: true,
  site: "https://www.coingecko.com/en/api",
  note: "Bitcoin's share of the total crypto market capitalisation (dominance).",
  async fetch() {
    const d = await getJson("https://api.coingecko.com/api/v3/global", { provider: "coingecko" });
    return { dominance: num(d.data?.market_cap_percentage?.btc), totalMarketCapUsd: num(d.data?.total_market_cap?.usd) };
  },
};

export const mempool = {
  id: "mempool",
  name: "mempool.space",
  kind: "btcextra",
  needsKey: false,
  defaultEnabled: false,
  site: "https://mempool.space/docs/api",
  note: "Bitcoin network: current block height and recommended transaction fees (sat/vB).",
  async fetch() {
    const [height, fees] = await Promise.all([
      getJson("https://mempool.space/api/blocks/tip/height", { provider: "mempool" }),
      getJson("https://mempool.space/api/v1/fees/recommended", { provider: "mempool" }),
    ]);
    return { network: { blockHeight: num(height), fees: { fast: num(fees.fastestFee), halfHour: num(fees.halfHourFee), hour: num(fees.hourFee) } } };
  },
};
