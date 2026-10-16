/* GET /api/prices?symbol=VWRL.LON: monthly prices for an exchange-listed fund (controllers/prices.js).
     501 when no ALPHAVANTAGE_KEY is set, 400 for something that is not a ticker, 502 when the
     provider refuses (the message says why). */
'use strict';
const { createRouteTable } = require('./table.js');
const { createPriceController } = require('../controllers/prices.js');

function createPriceRoute({ prices, send }) {
  const c = createPriceController({ prices, send });
  return createRouteTable([
    { path: '/api/prices', methods: { GET: c.monthly } },
  ], { send });
}

module.exports = { createPriceRoute };
