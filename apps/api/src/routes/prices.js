/* GET /api/prices?symbol=VWRL.LON: monthly prices for an exchange-listed fund, as the provider's CSV.
     501 when no ALPHAVANTAGE_KEY is set, 400 for something that is not a ticker, 502 when the
     provider refuses (the message says why). */
'use strict';

const TICKER = /^[A-Z0-9][A-Z0-9.\-]{0,19}$/;

function createPriceRoute({ prices, send }) {
  return async function priceRoute(req, res, p) {
    if (p !== '/api/prices' || req.method !== 'GET') return false;
    if (!prices.enabled) { send(res, 501, { error: 'Automatic prices are not set up. Ask your administrator to add an Alpha Vantage key, or import a CSV.' }); return true; }
    const symbol = String(new URL(req.url, 'http://localhost').searchParams.get('symbol') || '').trim().toUpperCase();
    if (!TICKER.test(symbol)) { send(res, 400, { error: 'Enter an exchange ticker such as VWRL.LON' }); return true; }
    send(res, 200, { symbol, csv: await prices.monthly(symbol) });
    return true;
  };
}

module.exports = { createPriceRoute };
