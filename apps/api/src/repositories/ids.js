// Household ids are UUIDs (crypto.randomUUID); anything else is refused before it reaches storage
'use strict';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
module.exports = { ID_RE };
