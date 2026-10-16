// Household and firm ids are UUIDs (crypto.randomUUID); anything else is refused before it reaches storage
'use strict';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The firm every record from before tenancy belongs to (migration 0004), and the firm that
// development-only Basic sign-in maps every user to
const DEFAULT_FIRM_ID = 'f1a00000-0000-4000-8000-000000000001';
module.exports = { ID_RE, DEFAULT_FIRM_ID };
