import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_DIR = 'C:/Users/Michael/Documents/Web Apps/part-scraper-app';
const ENV_PATH = `${PROJECT_DIR}/.env`;
const DB_PATH = `${PROJECT_DIR}/part-cache.sqlite`;

const PARTS = [
  'SMV1249-079LF',
  'SMP1330-005LF',
  'SMP1322-005LF',
  'SMP1340-007LF',
  'SMP1321-040LF'
];

const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .map((line) => {
      const eqIndex = line.indexOf('=');
      return [line.slice(0, eqIndex), line.slice(eqIndex + 1)];
    })
    .filter(([key]) => key)
);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

const upsertPartRecord = db.prepare(`
  INSERT INTO part_records (
    query_key,
    query,
    source_line,
    result_json,
    raw_json,
    updated_at
  )
  VALUES (
    @query_key,
    @query,
    @source_line,
    @result_json,
    @raw_json,
    @updated_at
  )
  ON CONFLICT(query_key) DO UPDATE SET
    query = excluded.query,
    source_line = excluded.source_line,
    result_json = excluded.result_json,
    raw_json = excluded.raw_json,
    updated_at = excluded.updated_at
`);

const tokenResponse = await fetch('https://api.digikey.com/v1/oauth2/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: new URLSearchParams({
    client_id: env.DIGIKEY_CLIENT_ID,
    client_secret: env.DIGIKEY_CLIENT_SECRET,
    grant_type: 'client_credentials'
  })
});

const tokenPayload = await tokenResponse.json();
if (!tokenPayload.access_token) {
  throw new Error(`Could not obtain DigiKey token: ${JSON.stringify(tokenPayload)}`);
}

const headers = {
  'Content-Type': 'application/json',
  'X-DIGIKEY-Client-Id': env.DIGIKEY_CLIENT_ID,
  'X-DIGIKEY-Customer-Id': env.DIGIKEY_CUSTOMER_ID || '0',
  'X-DIGIKEY-Locale-Language': env.DIGIKEY_LOCALE_LANGUAGE || 'en',
  'X-DIGIKEY-Locale-Currency': env.DIGIKEY_LOCALE_CURRENCY || 'USD',
  'X-DIGIKEY-Locale-Site': env.DIGIKEY_LOCALE_SITE || 'US',
  Authorization: `Bearer ${tokenPayload.access_token}`
};

const summary = [];

for (const part of PARTS) {
  const searchResponse = await fetch('https://api.digikey.com/products/v4/search/keyword', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      Keywords: part,
      RecordCount: 3
    })
  });

  const searchPayload = await searchResponse.json();
  const products = Array.isArray(searchPayload.Products) ? searchPayload.Products : [];
  const firstProduct = products[0] || {};
  const productVariations = Array.isArray(firstProduct.ProductVariations) ? firstProduct.ProductVariations : [];
  const preferredVariation =
    productVariations.find((variation) => variation?.PackageType?.Name === 'Cut Tape (CT)') ||
    productVariations[0] ||
    {};
  const standardPricing = Array.isArray(preferredVariation.StandardPricing) ? preferredVariation.StandardPricing : [];
  const priceTier = standardPricing.find((row) => row?.BreakQuantity === 1) || standardPricing[0] || {};

  const record = {
    query: part,
    sourceLine: part,
    matchedDigiKeyPartNumber: preferredVariation.DigiKeyProductNumber || firstProduct.ProductNumber || '',
    matchedManufacturerPartNumber: firstProduct.ManufacturerProductNumber || '',
    manufacturerName: firstProduct.Manufacturer?.Name || '',
    description: firstProduct.Description?.DetailedDescription || firstProduct.Description?.ProductDescription || '',
    package: preferredVariation.PackageType?.Name || '',
    productStatus: firstProduct.ProductStatus?.Status || '',
    stock: preferredVariation.QuantityAvailableforPackageType ?? '',
    quantityAvailable: preferredVariation.QuantityAvailableforPackageType ?? '',
    minimumOrderQuantity: preferredVariation.MinimumOrderQuantity ?? '',
    unitPrice: priceTier.UnitPrice ?? firstProduct.UnitPrice ?? '',
    currency: env.DIGIKEY_LOCALE_CURRENCY || 'USD',
    productUrl: firstProduct.ProductUrl || '',
    recommendations: [],
    searchResults: [],
    cacheStatus: 'miss',
    cacheHit: false,
    notes: 'Saved from direct live DigiKey verification script'
  };

  upsertPartRecord.run({
    query_key: part.replace(/[^A-Z0-9]+/gi, '').toUpperCase(),
    query: part,
    source_line: part,
    result_json: JSON.stringify(record),
    raw_json: JSON.stringify(searchPayload),
    updated_at: new Date().toISOString()
  });

  summary.push({
    part,
    price: record.unitPrice,
    currency: record.currency,
    stock: record.stock,
    digikeyPart: record.matchedDigiKeyPartNumber
  });
}

const savedRows = db
  .prepare(
    `
    SELECT query, updated_at
    FROM part_records
    WHERE query IN (${PARTS.map(() => '?').join(', ')})
    ORDER BY query
  `
  )
  .all(...PARTS);

console.log(JSON.stringify({ summary, savedRows }, null, 2));
