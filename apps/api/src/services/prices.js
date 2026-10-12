/* Monthly price history for exchange-listed funds from Alpha Vantage (optional; set
   ALPHAVANTAGE_KEY). OEICs and unit trusts are imported from CSV in the browser instead.
     enabled            whether a key is set
     monthly(symbol)    the provider's CSV text; cached for 12 hours per symbol. Throws an error
                        with status 502 and a message for the adviser when the provider refuses. */
'use strict';

const CACHE_MS = 12 * 3600e3;

function createPriceService({ key, fetch = globalThis.fetch, now = Date.now }) {
  const cache = new Map(); // symbol -> { at, text }
  return {
    enabled: !!key,
    async monthly(symbol) {
      const hit = cache.get(symbol);
      if (hit && now() - hit.at < CACHE_MS) return hit.text;
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&datatype=csv&apikey=${encodeURIComponent(key)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      if (!r.ok || !/^timestamp,/i.test(text)) {
        const msg = /Invalid API call/i.test(text) ? 'The data provider does not recognise that ticker. Try the exchange suffix, e.g. VWRL.LON.' : /rate limit|frequency|premium/i.test(text) ? 'The free data allowance for today is used up. Try again tomorrow or import a CSV.' : 'The data provider did not return prices.';
        throw Object.assign(new Error(msg), { status: 502 });
      }
      cache.set(symbol, { at: now(), text });
      return text;
    },
  };
}

module.exports = { createPriceService };
