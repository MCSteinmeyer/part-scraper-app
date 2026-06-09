import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const APP_NAME = 'part-scraper-app';
const APP_VERSION = '0.1.0';
const WIDGET_URI = 'ui://part-scraper-widget/v1/index.html';
const WIDGET_HTML = readFileSync(new URL('./widget.html', import.meta.url), 'utf8');
const ENV_URL = new URL('../.env', import.meta.url);
const DB_URL = new URL('../part-cache.sqlite', import.meta.url);
const DEBUG_LOG_URL = new URL('../debug.log', import.meta.url);
const DB_PATH = fileURLToPath(DB_URL);
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DIGIKEY_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PARTS = 10;
const DEFAULT_MAX_RECOMMENDATIONS = 3;

let digikeyRequestChain = Promise.resolve();
let digikeyTokenCache = null;
let database = null;
let partLookupProgress = createProgressState();

loadDotEnv();

const server = new McpServer(
  {
    name: APP_NAME,
    version: APP_VERSION
  },
  {
    instructions:
      'Use the part analysis tool when a user pastes an email clip, part list, or messy text that may contain one or more part numbers. Extract likely part numbers, look up DigiKey stock, pricing, and product status, and recommend likely drop-in substitutes. Cache every lookup locally in SQLite so repeated lookups stay fast.'
  }
);

server.registerResource(
  'part-scraper-widget',
  WIDGET_URI,
  {
    title: 'Part Scraper Widget',
    description: 'Paste email clips, extract part numbers, and review DigiKey stock, price, status, and substitute suggestions.',
    mimeType: 'text/html;profile=mcp-app',
    _meta: {
      ui: {
        csp: {
          connectDomains: ['https://api.digikey.com'],
          resourceDomains: []
        },
        prefersBorder: true
      },
      'openai/widgetDescription':
        'Paste an email clip or part note, extract likely part numbers, and inspect DigiKey stock, price, status, and likely drop-in substitutes.'
    }
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/html;profile=mcp-app',
        text: WIDGET_HTML
      }
    ]
  })
);

server.registerTool(
  'parts.analyze_clip',
  {
    title: 'Analyze Part Clip',
    description:
      'Use this when you have an email clip or pasted text with one or more part numbers and want extracted candidates, DigiKey lookups, and likely drop-in substitutes stored in the local SQLite cache.',
    inputSchema: z.object({
      clipText: z.string().min(1).describe('Email clip, pasted quote text, or part note to analyze.'),
      maxParts: z.number().int().min(1).max(25).default(DEFAULT_MAX_PARTS).describe('Maximum number of unique part candidates to inspect.'),
      maxRecommendations: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(DEFAULT_MAX_RECOMMENDATIONS)
        .describe('Maximum number of substitute recommendations to return for each part.')
    }),
    annotations: {
      idempotentHint: true
    },
    _meta: {
      'openai/outputTemplate': WIDGET_URI,
      ui: {
        resourceUri: WIDGET_URI
      }
    }
  },
  async ({ clipText, maxParts, maxRecommendations }) => {
    partLookupProgress = {
      active: true,
      totalParts: 0,
      completedParts: 0,
      currentPart: '',
      startedAt: new Date().toISOString(),
      finishedAt: null
    };

    try {
      const analysis = await analyzePartClip(clipText, { maxParts, maxRecommendations });
      partLookupProgress = {
        ...partLookupProgress,
        active: false,
        completedParts: analysis.parts.length,
        finishedAt: new Date().toISOString()
      };

      return {
        content: [
          {
            type: 'text',
            text: renderAnalysisSummary(analysis)
          }
        ],
        structuredContent: analysis
      };
    } catch (error) {
      partLookupProgress = {
        ...partLookupProgress,
        active: false,
        finishedAt: new Date().toISOString()
      };
      throw error;
    }
  }
);

server.registerTool(
  'parts.cache_summary',
  {
    title: 'Inspect Local Part Cache',
    description: 'Use this when you want a quick read-only summary of the local SQLite cache that stores looked-up part data.',
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true
    }
  },
  async () => {
    const summary = getCacheSummary();
    return {
      content: [
        {
          type: 'text',
          text: [
            `Cached part records: ${summary.totalRecords}.`,
            summary.lastUpdatedAt ? `Most recent update: ${summary.lastUpdatedAt}.` : 'The cache is still empty.'
          ].join('\n')
        }
      ],
      structuredContent: {
        kind: 'part_cache_summary',
        ...summary
      }
    };
  }
);

server.registerTool(
  'parts.technical_parameters',
  {
    title: 'Get Technical Parameters',
    description:
      'Use this when you have a specific part number and want the stored DigiKey technical parameters. If the part is not already cached locally, the app will query DigiKey, cache the result, and then return the parameters or a reason they were unavailable.',
    inputSchema: z.object({
      partNumber: z.string().min(1).describe('Manufacturer part number or DigiKey part number to inspect.')
    }),
    annotations: {
      idempotentHint: true
    }
  },
  async ({ partNumber }) => {
    const result = await getTechnicalParametersForPartNumber(partNumber);
    return {
      content: [
        {
          type: 'text',
          text: renderTechnicalParametersSummary(result)
        }
      ],
      structuredContent: {
        kind: 'technical_parameters_lookup',
        ...result
      }
    };
  }
);

server.registerTool(
  'parts.compare_parts',
  {
    title: 'Compare Two Parts',
    description:
      'Use this when you want a direct technical-parameter comparison between a source part and one candidate substitute part.',
    inputSchema: z.object({
      sourcePartNumber: z.string().min(1).describe('Original part number.'),
      candidatePartNumber: z.string().min(1).describe('Candidate substitute part number.')
    }),
    annotations: {
      idempotentHint: true
    }
  },
  async ({ sourcePartNumber, candidatePartNumber }) => {
    const sourceLookup = await getOrFetchPartRecord(sourcePartNumber);
    const candidateLookup = await getOrFetchPartRecord(candidatePartNumber);
    const sourceTechnical = await getTechnicalParametersForPartNumber(sourcePartNumber);
    const candidateTechnical = await getTechnicalParametersForPartNumber(candidatePartNumber);
    const comparison = compareTechnicalParameters(sourceTechnical, candidateTechnical, {
      sourceRecord: sourceLookup.record,
      candidateRecord: candidateLookup.record
    });

    return {
      content: [
        {
          type: 'text',
          text: renderPartComparisonSummary(sourceTechnical, comparison)
        }
      ],
      structuredContent: {
        kind: 'part_comparison',
        sourcePartNumber: sourceTechnical.partNumber,
        candidatePartNumber: comparison.candidatePartNumber,
        comparison
      }
    };
  }
);

server.registerTool(
  'parts.rank_substitutes',
  {
    title: 'Rank Substitute Candidates',
    description:
      'Use this when you have a source part number and want the app to compare likely or supplied substitute candidates using technical parameters, stock, status, and price.',
    inputSchema: z.object({
      sourcePartNumber: z.string().min(1).describe('Original part number that needs a substitute.'),
      candidatePartNumbers: z
        .array(z.string().min(1))
        .max(12)
        .optional()
        .describe('Optional candidate part numbers. If omitted, the app will use the source part lookup recommendations.'),
      maxCandidates: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(5)
        .describe('Maximum number of candidates to rank.')
    }),
    annotations: {
      idempotentHint: true
    }
  },
  async ({ sourcePartNumber, candidatePartNumbers, maxCandidates }) => {
    const result = await rankSubstituteCandidates(sourcePartNumber, candidatePartNumbers ?? [], {
      maxCandidates
    });
    return {
      content: [
        {
          type: 'text',
          text: renderSubstituteRankingSummary(result)
        }
      ],
      structuredContent: {
        kind: 'substitute_ranking',
        ...result
      }
    };
  }
);

async function analyzePartClip(clipText, { maxParts, maxRecommendations }) {
  const normalizedClipText = String(clipText || '').trim();
  appendDebugLog([
    `=== ${new Date().toISOString()} ===`,
    'Clip analysis started',
    `Clip hash: ${hashText(normalizedClipText)}`,
    `Clip length: ${normalizedClipText.length}`,
    `Max parts: ${maxParts}`,
    `Max recommendations: ${maxRecommendations}`,
    `Clip text: ${normalizedClipText}`,
    ''
  ]);

  if (!normalizedClipText) {
    return {
      kind: 'part_clip_analysis',
      clipHash: hashText(''),
      clipLength: 0,
      extractedParts: [],
      parts: [],
      unparsedLines: [],
      cacheSummary: getCacheSummary()
    };
  }

  const candidates = extractPartCandidates(normalizedClipText, maxParts);
  partLookupProgress = {
    ...partLookupProgress,
    totalParts: candidates.length,
    completedParts: 0,
    currentPart: candidates[0]?.query ?? ''
  };

  const parts = [];
  const localLookupCache = new Map();
  const lines = splitIntoLines(normalizedClipText);
  const consumedLineIndexes = new Set();

  for (const candidate of candidates) {
    partLookupProgress.currentPart = candidate.query;
    const result = await lookupPartCandidate(candidate, {
      maxRecommendations,
      localLookupCache
    });
    if (Number.isInteger(candidate.lineIndex)) {
      consumedLineIndexes.add(candidate.lineIndex);
    }
    parts.push(result);
    partLookupProgress.completedParts = parts.length;
  }

  const unparsedLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => line && !consumedLineIndexes.has(index))
    .slice(0, 12)
    .map(({ line }) => line);

  const analysis = {
    kind: 'part_clip_analysis',
    clipHash: hashText(normalizedClipText),
    clipLength: normalizedClipText.length,
    extractedParts: candidates.map((candidate) => ({
      query: candidate.query,
      sourceLine: candidate.sourceLine,
      lineIndex: candidate.lineIndex
    })),
    parts,
    unparsedLines,
    cacheSummary: getCacheSummary()
  };

  storeClipAnalysis(normalizedClipText, analysis);
  appendDebugLog([
    `Analysis complete`,
    `Detected parts: ${analysis.parts.length}`,
    `Unparsed lines: ${analysis.unparsedLines.length}`,
    ''
  ]);
  return analysis;
}

async function lookupPartCandidate(candidate, { maxRecommendations, localLookupCache }) {
  const cacheKey = normalizeQueryKey(candidate.query);
  const cached = getCachedPartRecord(cacheKey);
  if (cached && !isCacheStale(cached.updatedAt)) {
    appendDebugLog([
      `Lookup cache hit: ${candidate.query}`,
      `Source line: ${candidate.sourceLine}`,
      `Cache status: fresh`,
      ''
    ]);
    return {
      ...cached.record,
      cacheHit: true,
      cacheStatus: 'fresh'
    };
  }

  const localCacheHit = localLookupCache.get(cacheKey);
  if (localCacheHit) {
    appendDebugLog([
      `Lookup cache hit: ${candidate.query}`,
      `Source line: ${candidate.sourceLine}`,
      `Cache status: in_memory`,
      ''
    ]);
    return {
      ...localCacheHit,
      cacheHit: true,
      cacheStatus: 'in_memory'
    };
  }

  const searchRequestBody = {
    Keywords: candidate.query,
    RecordCount: Math.max(maxRecommendations + 4, 8)
  };

  const searchResponse = candidate.query
    ? await fetchDigiKey('POST', '/products/v4/search/keyword', searchRequestBody)
    : { results: [] };

  const searchItems = extractProductItems(searchResponse);
  const selected = chooseBestCandidate(searchItems, candidate.query, candidate.sourceLine);
  const matchedProductNumber = extractDigiKeyProductNumber(selected);
  const details = matchedProductNumber
    ? await fetchDigiKey('GET', `/products/v4/search/${encodeURIComponent(matchedProductNumber)}/productdetails`, null, {
        accountId: readEnv('DIGIKEY_ACCOUNT_ID', '').trim()
      })
    : {};
  const pricing = matchedProductNumber
    ? await fetchDigiKey('GET', `/products/v4/search/${encodeURIComponent(matchedProductNumber)}/pricing`, null, {
        accountId: readEnv('DIGIKEY_ACCOUNT_ID', '').trim()
      })
    : {};

  const normalizedResult = normalizePartLookupResult({
    candidate,
    searchResponse,
    searchItems,
    selected,
    details,
    pricing,
    maxRecommendations
  });

  appendDebugLog([
    `Lookup cache miss: ${candidate.query}`,
    `Source line: ${candidate.sourceLine}`,
    `Matched DigiKey part: ${normalizedResult.matchedDigiKeyPartNumber || ''}`,
    `Matched manufacturer part: ${normalizedResult.matchedManufacturerPartNumber || ''}`,
    `Status: ${normalizedResult.productStatus || ''}`,
    `Stock: ${normalizedResult.stock || ''}`,
    `Unit price: ${normalizedResult.unitPrice || ''}`,
    'Search request:',
    stringifyDebugPayload(searchRequestBody),
    'Search response:',
    stringifyDebugPayload(searchResponse),
    'Details response:',
    stringifyDebugPayload(details),
    'Pricing response:',
    stringifyDebugPayload(pricing),
    ''
  ]);

  upsertPartRecord(cacheKey, {
    query: candidate.query,
    sourceLine: candidate.sourceLine,
    result: normalizedResult,
    raw: {
      searchResponse,
      details,
      pricing
    }
  });

  localLookupCache.set(cacheKey, normalizedResult);
  return {
    ...normalizedResult,
    cacheHit: false,
    cacheStatus: 'miss'
  };
}

async function getTechnicalParametersForPartNumber(partNumber) {
  const normalizedPartNumber = normalizeCandidateQuery(partNumber);
  const cacheKey = normalizeQueryKey(normalizedPartNumber);
  const cachedBeforeLookup = getCachedPartRecordWithRaw(cacheKey);

  if (!normalizedPartNumber) {
    return {
      partNumber: normalizedPartNumber,
      matchedPartNumber: '',
      manufacturerPartNumber: '',
      manufacturerName: '',
      cacheStatus: 'invalid',
      cacheHit: false,
      source: 'none',
      technicalParameters: [],
      reason: 'Part number is empty after normalization.'
    };
  }

  let cached = cachedBeforeLookup;
  let source = cached ? 'cache' : 'live';
  let servedCacheStatus = cached && !isCacheStale(cached.updatedAt) ? 'fresh' : 'missing';

  if (!cached || isCacheStale(cached.updatedAt)) {
    const lookedUp = await lookupPartCandidate(
      {
        query: normalizedPartNumber,
        sourceLine: normalizedPartNumber,
        lineIndex: null
      },
      {
        maxRecommendations: DEFAULT_MAX_RECOMMENDATIONS,
        localLookupCache: new Map()
      }
    );

    cached = getCachedPartRecordWithRaw(cacheKey);
    source = lookedUp?.cacheHit ? 'cache' : 'live';
    servedCacheStatus = lookedUp?.cacheStatus || (cached ? 'fresh' : 'miss');
  }

  const record = cached?.record ?? {};
  const raw = cached?.raw ?? {};
  const rawBestObject = extractBestObject(raw?.details ?? raw?.searchResponse ?? raw);
  const technicalParameters = extractTechnicalParameters(raw);
  const reason = inferTechnicalParametersReason({
    partNumber: normalizedPartNumber,
    record,
    raw,
    technicalParameters
  });

  appendDebugLog([
    `Technical parameters lookup: ${normalizedPartNumber}`,
    `Source: ${source}`,
    `Cache status: ${servedCacheStatus}`,
    `Matched DigiKey part: ${record.matchedDigiKeyPartNumber || ''}`,
    `Matched manufacturer part: ${record.matchedManufacturerPartNumber || ''}`,
    `Parameters found: ${technicalParameters.length}`,
    `Reason: ${reason}`,
    ''
  ]);

  return {
    partNumber: normalizedPartNumber,
    matchedPartNumber: record.matchedDigiKeyPartNumber || '',
    manufacturerPartNumber: record.matchedManufacturerPartNumber || '',
    manufacturerName: coalesceMeaningfulText(record.manufacturerName, extractDigiKeyManufacturerName(rawBestObject)) || '',
    description: coalesceMeaningfulText(record.description, extractDigiKeyDescription(rawBestObject)) || '',
    productStatus: coalesceMeaningfulText(record.productStatus, extractProductStatusInfo(rawBestObject).status) || '',
    cacheStatus: servedCacheStatus,
    cacheHit: source === 'cache',
    source,
    technicalParameters,
    reason
  };
}

async function rankSubstituteCandidates(sourcePartNumber, candidatePartNumbers = [], { maxCandidates = 5 } = {}) {
  const normalizedSourcePartNumber = normalizeCandidateQuery(sourcePartNumber);
  const sourceLookup = await getOrFetchPartRecord(normalizedSourcePartNumber, {
    maxRecommendations: Math.max(maxCandidates, DEFAULT_MAX_RECOMMENDATIONS)
  });
  const sourceTechnical = await getTechnicalParametersForPartNumber(normalizedSourcePartNumber);

  const derivedCandidates = deriveCandidatePartNumbers(sourceLookup.record, maxCandidates);
  const fallbackCandidates =
    derivedCandidates.length > 0
      ? []
      : await fetchDerivedCandidatePartNumbers(normalizedSourcePartNumber, sourceLookup.record, maxCandidates);
  const requestedCandidates = Array.isArray(candidatePartNumbers) ? candidatePartNumbers : [];
  const finalCandidatePartNumbers = dedupePartNumbers(
    requestedCandidates.length ? requestedCandidates : [...derivedCandidates, ...fallbackCandidates]
  )
    .filter((partNumber) => normalizeQueryKey(partNumber) !== normalizeQueryKey(normalizedSourcePartNumber))
    .slice(0, maxCandidates);

  const comparisons = [];
  for (const candidatePartNumber of finalCandidatePartNumbers) {
    const candidateLookup = await getOrFetchPartRecord(candidatePartNumber, {
      maxRecommendations: Math.max(maxCandidates, DEFAULT_MAX_RECOMMENDATIONS)
    });
    const candidateTechnical = await getTechnicalParametersForPartNumber(candidatePartNumber);
    comparisons.push(compareTechnicalParameters(sourceTechnical, candidateTechnical, {
      sourceRecord: sourceLookup.record,
      candidateRecord: candidateLookup.record
    }));
  }

  comparisons.sort((a, b) => b.score - a.score);

  const result = {
    sourcePartNumber: normalizedSourcePartNumber,
    sourceMatch: {
      matchedPartNumber: sourceTechnical.matchedPartNumber,
      manufacturerPartNumber: sourceTechnical.manufacturerPartNumber,
      manufacturerName: sourceTechnical.manufacturerName,
      description: sourceTechnical.description,
      productStatus: sourceTechnical.productStatus,
      technicalParameterCount: sourceTechnical.technicalParameters.length,
      reason: sourceTechnical.reason
    },
    candidateCount: comparisons.length,
    candidates: comparisons,
    reason:
      comparisons.length > 0
        ? `Ranked ${comparisons.length} candidate substitute${comparisons.length === 1 ? '' : 's'}.`
        : 'No substitute candidates were available to rank.'
  };

  appendDebugLog([
    `Substitute ranking: ${normalizedSourcePartNumber}`,
    `Candidate count: ${comparisons.length}`,
    `Candidates: ${finalCandidatePartNumbers.join(', ')}`,
    `Reason: ${result.reason}`,
    ''
  ]);

  return result;
}

async function getOrFetchPartRecord(partNumber, { maxRecommendations = DEFAULT_MAX_RECOMMENDATIONS } = {}) {
  const normalizedPartNumber = normalizeCandidateQuery(partNumber);
  const cacheKey = normalizeQueryKey(normalizedPartNumber);
  let cached = getCachedPartRecordWithRaw(cacheKey);

  if (!cached || isCacheStale(cached.updatedAt)) {
    await lookupPartCandidate(
      {
        query: normalizedPartNumber,
        sourceLine: normalizedPartNumber,
        lineIndex: null
      },
      {
        maxRecommendations,
        localLookupCache: new Map()
      }
    );
    cached = getCachedPartRecordWithRaw(cacheKey);
  }

  return {
    partNumber: normalizedPartNumber,
    record: cached?.record ?? emptyPartLookupRecord(normalizedPartNumber),
    raw: cached?.raw ?? {},
    cacheStatus: cached ? (isCacheStale(cached.updatedAt) ? 'stale' : 'fresh') : 'missing'
  };
}

function emptyPartLookupRecord(partNumber) {
  return {
    query: partNumber,
    sourceLine: partNumber,
    matchedDigiKeyPartNumber: '',
    matchedManufacturerPartNumber: '',
    manufacturerName: '',
    description: '',
    package: '',
    productStatus: '',
    stock: '',
    quantityAvailable: '',
    minimumOrderQuantity: '',
    unitPrice: '',
    currency: readEnv('DIGIKEY_LOCALE_CURRENCY', 'USD'),
    productUrl: '',
    recommendations: [],
    searchResults: [],
    cacheStatus: 'miss',
    cacheHit: false,
    notes: ''
  };
}

function deriveCandidatePartNumbers(sourceRecord, maxCandidates) {
  const values = [];
  for (const recommendation of sourceRecord?.recommendations ?? []) {
    const manufacturerPartNumber = normalizeCandidateQuery(
      recommendation.manufacturerPartNumber || recommendation.matchedManufacturerPartNumber || ''
    );
    const productNumber = normalizeCandidateQuery(
      recommendation.productNumber || recommendation.matchedDigiKeyPartNumber || ''
    );

    if (manufacturerPartNumber) {
      values.push(manufacturerPartNumber);
    } else if (productNumber) {
      values.push(productNumber);
    }
  }

  return dedupePartNumbers(values).slice(0, maxCandidates);
}

async function fetchDerivedCandidatePartNumbers(sourcePartNumber, sourceRecord, maxCandidates) {
  const queries = buildCandidateDiscoveryQueries(
    sourceRecord?.matchedManufacturerPartNumber || sourceRecord?.query || sourcePartNumber
  );
  const sourceLine = sourceRecord?.description || sourceRecord?.sourceLine || sourcePartNumber;
  const collected = [];

  for (const query of queries) {
    const searchRequestBody = {
      Keywords: query,
      RecordCount: Math.max(maxCandidates + 6, 10)
    };
    const searchResponse = await fetchDigiKey('POST', '/products/v4/search/keyword', searchRequestBody);
    const searchItems = extractProductItems(searchResponse);
    if (!searchItems.length) {
      continue;
    }

    const selected = chooseBestCandidate(searchItems, query, sourceLine);
    const fallbackRecommendations = buildRecommendations({
      sourceQuery: query,
      sourceLine,
      selected,
      searchItems,
      maxRecommendations: maxCandidates + 2
    });

    collected.push(
      ...fallbackRecommendations.map((item) => item.manufacturerPartNumber || item.productNumber || '')
    );
  }

  return dedupePartNumbers(collected).slice(0, maxCandidates);
}

function buildCandidateDiscoveryQueries(partNumber) {
  const normalized = normalizeCandidateQuery(partNumber);
  if (!normalized) {
    return [];
  }

  const values = [normalized];
  const dashBase = normalized.split('-')[0];
  if (dashBase && dashBase !== normalized) {
    values.push(dashBase);
  }

  const alphaNumericBase = normalized.match(/^[A-Z]+[0-9]+/);
  if (alphaNumericBase?.[0] && alphaNumericBase[0] !== normalized && alphaNumericBase[0] !== dashBase) {
    values.push(alphaNumericBase[0]);
  }

  return dedupePartNumbers(values);
}

function dedupePartNumbers(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeCandidateQuery(value);
    const key = normalizeQueryKey(normalized);
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function compareTechnicalParameters(sourceTechnical, candidateTechnical, { sourceRecord, candidateRecord }) {
  const sourceParameters = indexTechnicalParameters(sourceTechnical.technicalParameters);
  const candidateParameters = indexTechnicalParameters(candidateTechnical.technicalParameters);
  const checks = [];

  const packageCheck = comparePackageCompatibility(sourceParameters, candidateParameters, sourceRecord, candidateRecord);
  checks.push(packageCheck);
  checks.push(compareNamedNumericParameter(sourceParameters, candidateParameters, {
    label: 'reverse voltage',
    sourceNames: ['Voltage - Peak Reverse (Max)'],
    candidateNames: ['Voltage - Peak Reverse (Max)'],
    comparator: 'candidate_gte_source',
    weight: 22
  }));
  checks.push(compareNamedNumericParameter(sourceParameters, candidateParameters, {
    label: 'capacitance ratio',
    sourceNames: ['Capacitance Ratio'],
    candidateNames: ['Capacitance Ratio'],
    comparator: 'close_ratio',
    weight: 16,
    tolerancePercent: 12
  }));
  checks.push(compareNamedNumericParameter(sourceParameters, candidateParameters, {
    label: 'capacitance',
    sourceNames: ['Capacitance @ Vr, F'],
    candidateNames: ['Capacitance @ Vr, F'],
    comparator: 'close_ratio',
    weight: 16,
    tolerancePercent: 20
  }));
  checks.push(compareNamedTextParameter(sourceParameters, candidateParameters, {
    label: 'diode type',
    names: ['Diode Type'],
    weight: 12
  }));
  checks.push(compareTemperatureRange(sourceParameters, candidateParameters, {
    label: 'operating temperature',
    names: ['Operating Temperature'],
    weight: 12
  }));
  const supplierPackageCheck = compareNamedTextParameter(sourceParameters, candidateParameters, {
    label: 'supplier device package',
    names: ['Supplier Device Package'],
    weight: 12
  });
  checks.push(supplierPackageCheck);

  const candidateStatusText = candidateTechnical.productStatus || candidateRecord.productStatus || '';
  const candidateManufacturerName = candidateTechnical.manufacturerName || candidateRecord.manufacturerName || '';
  const candidateDescription = candidateTechnical.description || candidateRecord.description || '';

  const statusAdjustment = buildStatusScoreAdjustment(candidateStatusText);
  const stockAdjustment = buildStockScoreAdjustment(candidateRecord);
  const priceAdjustment = buildPriceScoreAdjustment(candidateRecord);

  let score = 40;
  const reasons = [];
  const reviewNotes = [];

  for (const check of checks) {
    score += check.scoreDelta;
    if (check.reason) {
      reasons.push(check.reason);
    }
    if (check.review) {
      reviewNotes.push(check.review);
    }
  }

  score += statusAdjustment.scoreDelta + stockAdjustment.scoreDelta + priceAdjustment.scoreDelta;
  if (statusAdjustment.reason) reasons.push(statusAdjustment.reason);
  if (stockAdjustment.reason) reasons.push(stockAdjustment.reason);
  if (priceAdjustment.reason) reasons.push(priceAdjustment.reason);
  if (statusAdjustment.review) reviewNotes.push(statusAdjustment.review);
  if (stockAdjustment.review) reviewNotes.push(stockAdjustment.review);
  if (priceAdjustment.review) reviewNotes.push(priceAdjustment.review);

  if (!candidateTechnical.technicalParameters.length) {
    reviewNotes.push(candidateTechnical.reason);
    score -= 15;
  }
  if (!sourceTechnical.technicalParameters.length) {
    reviewNotes.push(sourceTechnical.reason);
    score -= 10;
  }

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  const category = determineCandidateCategory({
    score: normalizedScore,
    candidateStatusText,
    candidateStock: candidateRecord?.stock,
    packageCheck,
    supplierPackageCheck
  });

  return {
    candidatePartNumber: candidateTechnical.partNumber,
    matchedPartNumber: candidateTechnical.matchedPartNumber,
    manufacturerPartNumber: candidateTechnical.manufacturerPartNumber,
    manufacturerName: candidateManufacturerName,
    description: candidateDescription,
    productStatus: candidateStatusText,
    unitPrice: candidateRecord.unitPrice ?? '',
    currency: candidateRecord.currency || readEnv('DIGIKEY_LOCALE_CURRENCY', 'USD'),
    stock: candidateRecord.stock ?? '',
    quantityAvailable: candidateRecord.quantityAvailable ?? '',
    score: normalizedScore,
    category,
    reasons: dedupeStrings(reasons),
    reviewNotes: dedupeStrings(reviewNotes),
    technicalParameterCount: candidateTechnical.technicalParameters.length,
    technicalParameters: candidateTechnical.technicalParameters,
    productUrl: candidateRecord.productUrl || ''
  };
}

function normalizePartLookupResult({
  candidate,
  searchResponse,
  searchItems,
  selected,
  details,
  pricing,
  maxRecommendations
}) {
  const selectedProductNumber = extractDigiKeyProductNumber(selected);
  const bestDetails = extractBestObject(details);
  const productStatus = extractProductStatusInfo(selected, bestDetails);
  const stock = extractStock(selected, bestDetails, searchResponse, pricing);
  const quantityAvailable = extractQuantityAvailable(selected, bestDetails, searchResponse, pricing);
  const pricingRows = extractPricingRows(pricing);
  const bestPricingRow = pickPricingTier(pricingRows, 1) || pricingRows[0] || {};
  const unitPrice = extractUnitPrice(bestPricingRow);
  const currency = extractCurrency(bestPricingRow, selected, bestDetails, pricing);
  const productUrl = firstText(selected, ['productUrl', 'ProductUrl', 'url', 'Url']) || firstText(bestDetails, ['productUrl', 'ProductUrl', 'url', 'Url']) || '';
  const recommendedSubstitutes = buildRecommendations({
    sourceQuery: candidate.query,
    sourceLine: candidate.sourceLine,
    selected,
    searchItems,
    maxRecommendations
  });

  return {
    query: candidate.query,
    sourceLine: candidate.sourceLine,
    matchedDigiKeyPartNumber: selectedProductNumber,
    matchedManufacturerPartNumber:
      firstText(selected, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber']) || '',
    manufacturerName: extractDigiKeyManufacturerName(selected, bestDetails),
    description: extractDigiKeyDescription(selected, bestDetails),
    package: firstText(selected, ['package', 'Package', 'packageType', 'PackageType']) || firstText(bestDetails, ['package', 'Package', 'packageType', 'PackageType']) || '',
    productStatus: productStatus.status,
    stock,
    quantityAvailable,
    minimumOrderQuantity:
      parseInteger(firstValue(selected, ['minimumOrderQuantity', 'MinimumOrderQuantity', 'moq', 'Moq'])) ||
      parseInteger(firstValue(bestDetails, ['minimumOrderQuantity', 'MinimumOrderQuantity', 'moq', 'Moq'])) ||
      '',
    unitPrice: unitPrice ?? '',
    currency,
    productUrl,
    recommendations: recommendedSubstitutes,
    searchResults: searchItems.slice(0, maxRecommendations + 5).map((item) => summarizeProduct(item)),
    cacheStatus: 'miss',
    cacheHit: false,
    notes: buildLookupNotes({
      productStatus,
      stock,
      quantityAvailable,
      unitPrice,
      currency,
      selected,
      candidate
    })
  };
}

function buildRecommendations({ sourceQuery, sourceLine, selected, searchItems, maxRecommendations }) {
  const selectedProductNumber = extractDigiKeyProductNumber(selected);
  const selectedManufacturerPartNumber =
    firstText(selected, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber']) || '';
  const selectedDescription = extractDigiKeyDescription(selected);
  const selectedPackage = firstText(selected, ['package', 'Package', 'packageType', 'PackageType']) || '';
  const sourceTokens = tokenizeText(`${sourceQuery} ${sourceLine} ${selectedDescription}`);

  const candidates = searchItems
    .map((item) => {
      const productNumber = extractDigiKeyProductNumber(item);
      if (!productNumber || productNumber === selectedProductNumber) {
        return null;
      }

      const manufacturerPartNumber =
        firstText(item, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber']) || '';
      const description = extractDigiKeyDescription(item);
      const packageValue = firstText(item, ['package', 'Package', 'packageType', 'PackageType']) || '';
      const productStatus = extractProductStatusInfo(item);
      const stock = extractStock(item);
      const quantityAvailable = extractQuantityAvailable(item);
      const unitPrice = extractUnitPrice(pickPricingTier(extractPricingRows(item), 1));
      const currency = extractCurrency(item);
      const score = scoreRecommendation({
        sourceTokens,
        selectedManufacturerPartNumber,
        selectedDescription,
        selectedPackage,
        item,
        manufacturerPartNumber,
        description,
        packageValue,
        productStatus,
        stock,
        quantityAvailable,
        unitPrice
      });

      return {
        productNumber,
        manufacturerPartNumber,
        manufacturerName: extractDigiKeyManufacturerName(item),
        description,
        package: packageValue,
        productStatus: productStatus.status,
        stock,
        quantityAvailable,
        minimumOrderQuantity: parseInteger(firstValue(item, ['minimumOrderQuantity', 'MinimumOrderQuantity', 'moq', 'Moq'])) || '',
        unitPrice: unitPrice ?? '',
        currency,
        productUrl: firstText(item, ['productUrl', 'ProductUrl', 'url', 'Url']) || '',
        score,
        reason: buildRecommendationReason({
          score,
          selectedManufacturerPartNumber,
          selectedDescription,
          selectedPackage,
          description,
          packageValue,
          productStatus,
          stock,
          quantityAvailable
        })
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxRecommendations);

  return candidates.map((item, index) => ({
    ...item,
    rank: index + 1,
    confidence: item.score >= 35 ? 'high' : item.score >= 20 ? 'medium' : 'low'
  }));
}

function scoreRecommendation({
  sourceTokens,
  selectedManufacturerPartNumber,
  selectedDescription,
  selectedPackage,
  item,
  manufacturerPartNumber,
  description,
  packageValue,
  productStatus,
  stock,
  quantityAvailable,
  unitPrice
}) {
  const itemTokens = tokenizeText(`${manufacturerPartNumber} ${description} ${packageValue}`);
  let score = 0;

  if (manufacturerPartNumber && selectedManufacturerPartNumber && normalizeQueryKey(manufacturerPartNumber) === normalizeQueryKey(selectedManufacturerPartNumber)) {
    score += 80;
  }

  if (selectedDescription && description && normalizeQueryKey(description) === normalizeQueryKey(selectedDescription)) {
    score += 30;
  }

  if (selectedPackage && packageValue && normalizeQueryKey(selectedPackage) === normalizeQueryKey(packageValue)) {
    score += 20;
  }

  if (productStatus.status === 'active') {
    score += 10;
  }

  if (Number.isFinite(stock) && stock > 0) {
    score += Math.min(10, Math.max(2, Math.round(stock / 500)));
  }

  if (Number.isFinite(quantityAvailable) && quantityAvailable > 0) {
    score += Math.min(8, Math.max(2, Math.round(quantityAvailable / 500)));
  }

  if (Number.isFinite(unitPrice) && unitPrice > 0) {
    score += 5;
  }

  score += overlapScore(sourceTokens, itemTokens);

  const itemText = `${manufacturerPartNumber} ${description} ${packageValue} ${firstText(item, ['manufacturerName', 'ManufacturerName']) || ''}`.toUpperCase();
  if (itemText.includes('SOT-23')) {
    score += 2;
  }

  return score;
}

function buildRecommendationReason({
  score,
  selectedManufacturerPartNumber,
  selectedDescription,
  selectedPackage,
  description,
  packageValue,
  productStatus,
  stock,
  quantityAvailable
}) {
  const parts = [];
  if (selectedPackage && packageValue && normalizeQueryKey(selectedPackage) === normalizeQueryKey(packageValue)) {
    parts.push('matches package');
  }
  if (selectedDescription && description && normalizeQueryKey(selectedDescription) === normalizeQueryKey(description)) {
    parts.push('matches description');
  }
  if (productStatus.status === 'active') {
    parts.push('active part');
  }
  if (Number.isFinite(stock) && stock > 0) {
    parts.push(`${formatNumber(stock)} in stock`);
  } else if (Number.isFinite(quantityAvailable) && quantityAvailable > 0) {
    parts.push(`${formatNumber(quantityAvailable)} available`);
  }

  if (selectedManufacturerPartNumber && description && normalizeQueryKey(description).includes(normalizeQueryKey(selectedManufacturerPartNumber))) {
    parts.push('close manufacturer match');
  }

  if (!parts.length) {
    parts.push(`heuristic score ${score}`);
  }

  return parts.join(', ');
}

function buildLookupNotes({ productStatus, stock, quantityAvailable, unitPrice, currency, candidate }) {
  const notes = [];
  if (candidate.sourceLine) {
    notes.push(`Parsed from: ${candidate.sourceLine}`);
  }
  if (productStatus.status) {
    notes.push(`Status: ${productStatus.status}`);
  }
  if (Number.isFinite(stock)) {
    notes.push(`Stock: ${formatNumber(stock)}`);
  }
  if (Number.isFinite(quantityAvailable)) {
    notes.push(`Available: ${formatNumber(quantityAvailable)}`);
  }
  if (Number.isFinite(unitPrice)) {
    notes.push(`1-up price: ${formatCurrency(unitPrice, currency)}`);
  }
  return notes.join(' • ');
}

function renderAnalysisSummary(analysis) {
  if (!analysis.parts.length) {
    return [
      'No confident part numbers were detected in the pasted text.',
      'Try pasting a message that includes a manufacturer part number, DigiKey number, or a line labeled Part Number.'
    ].join('\n');
  }

  const lines = [
    `Detected ${analysis.parts.length} part${analysis.parts.length === 1 ? '' : 's'} and cached the lookups locally in SQLite.`
  ];

  for (const part of analysis.parts) {
    const bestMatch = part.matchedDigiKeyPartNumber ? `DigiKey ${part.matchedDigiKeyPartNumber}` : 'no DigiKey match';
    const priceText = Number.isFinite(part.unitPrice) ? `${formatCurrency(part.unitPrice, part.currency)} each` : 'price not available yet';
    const stockText = Number.isFinite(part.stock) ? `${formatNumber(part.stock)} in stock` : 'stock not available';
    const substituteText = part.recommendations.length
      ? part.recommendations.map((entry) => entry.matchedDigiKeyPartNumber || entry.productNumber).filter(Boolean).join(', ')
      : 'none found';

    lines.push(
      `- ${part.query}: ${bestMatch}, ${stockText}, ${priceText}. Likely substitutes: ${substituteText}.`
    );
  }

  return lines.join('\n');
}

function renderTechnicalParametersSummary(result) {
  const lines = [
    `Technical parameters for ${result.partNumber}:`,
    result.matchedPartNumber ? `Matched DigiKey part: ${result.matchedPartNumber}` : 'Matched DigiKey part: none',
    `Source: ${result.source}`,
    `Reason: ${result.reason}`
  ];

  if (!result.technicalParameters.length) {
    lines.push('No technical parameters were returned.');
    return lines.join('\n');
  }

  for (const entry of result.technicalParameters) {
    lines.push(`- ${entry.name}: ${entry.value}`);
  }

  return lines.join('\n');
}

function renderSubstituteRankingSummary(result) {
  const lines = [
    `Substitute ranking for ${result.sourcePartNumber}:`,
    result.sourceMatch.matchedPartNumber
      ? `Matched source DigiKey part: ${result.sourceMatch.matchedPartNumber}`
      : 'Matched source DigiKey part: none',
    result.reason
  ];

  if (!result.candidates.length) {
    return lines.join('\n');
  }

  for (const candidate of result.candidates) {
    const priceText = Number.isFinite(candidate.unitPrice)
      ? formatCurrency(candidate.unitPrice, candidate.currency)
      : 'price unavailable';
    const stockText = Number.isFinite(candidate.stock)
      ? `${formatNumber(candidate.stock)} in stock`
      : 'stock unavailable';
    lines.push(
      `- ${candidate.candidatePartNumber}: ${candidate.category} (${candidate.score}/100), ${stockText}, ${priceText}.`
    );
    if (candidate.reasons.length) {
      lines.push(`  Reasons: ${candidate.reasons.join('; ')}`);
    }
    if (candidate.reviewNotes.length) {
      lines.push(`  Review: ${candidate.reviewNotes.join('; ')}`);
    }
  }

  return lines.join('\n');
}

function renderPartComparisonSummary(sourceTechnical, comparison) {
  const lines = [
    `Comparison for ${sourceTechnical.partNumber} -> ${comparison.candidatePartNumber}:`,
    `Category: ${comparison.category}`,
    `Score: ${comparison.score}/100`
  ];

  if (comparison.reasons.length) {
    lines.push(`Reasons: ${comparison.reasons.join('; ')}`);
  }
  if (comparison.reviewNotes.length) {
    lines.push(`Review: ${comparison.reviewNotes.join('; ')}`);
  }

  return lines.join('\n');
}

function getCacheSummary() {
  const db = getDatabase();
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS totalRecords,
        MAX(updated_at) AS lastUpdatedAt
      FROM part_records
    `
    )
    .get();
  return {
    databasePath: DB_PATH,
    totalRecords: Number(row?.totalRecords ?? 0),
    lastUpdatedAt: row?.lastUpdatedAt ?? null
  };
}

function getCachedPartRecord(queryKey) {
  const row = getDatabase()
    .prepare(
      `
      SELECT query_key, query, source_line, result_json, updated_at
      FROM part_records
      WHERE query_key = ?
    `
    )
    .get(queryKey);

  if (!row) {
    return null;
  }

  try {
    return {
      updatedAt: row.updated_at,
      record: JSON.parse(row.result_json)
    };
  } catch {
    return null;
  }
}

function getCachedPartRecordWithRaw(queryKey) {
  const row = getDatabase()
    .prepare(
      `
      SELECT query_key, query, source_line, result_json, raw_json, updated_at
      FROM part_records
      WHERE query_key = ?
    `
    )
    .get(queryKey);

  if (!row) {
    return null;
  }

  try {
    return {
      updatedAt: row.updated_at,
      record: JSON.parse(row.result_json),
      raw: JSON.parse(row.raw_json)
    };
  } catch {
    return null;
  }
}

function upsertPartRecord(queryKey, { query, sourceLine, result, raw }) {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `
      INSERT INTO part_records (
        query_key,
        query,
        source_line,
        result_json,
        raw_json,
        updated_at
      )
      VALUES (
        @queryKey,
        @query,
        @sourceLine,
        @resultJson,
        @rawJson,
        @updatedAt
      )
      ON CONFLICT(query_key) DO UPDATE SET
        query = excluded.query,
        source_line = excluded.source_line,
        result_json = excluded.result_json,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `
    )
    .run({
      queryKey,
      query,
      sourceLine,
      resultJson: JSON.stringify(result),
      rawJson: JSON.stringify(raw),
      updatedAt: now
    });
}

function storeClipAnalysis(clipText, analysis) {
  const now = new Date().toISOString();
  const clipHash = hashText(clipText);
  getDatabase()
    .prepare(
      `
      INSERT INTO clip_analyses (
        clip_hash,
        clip_text,
        analysis_json,
        updated_at
      )
      VALUES (
        @clipHash,
        @clipText,
        @analysisJson,
        @updatedAt
      )
      ON CONFLICT(clip_hash) DO UPDATE SET
        clip_text = excluded.clip_text,
        analysis_json = excluded.analysis_json,
        updated_at = excluded.updated_at
    `
    )
    .run({
      clipHash,
      clipText,
      analysisJson: JSON.stringify(analysis),
      updatedAt: now
    });
}

function createProgressState() {
  return {
    active: false,
    totalParts: 0,
    completedParts: 0,
    currentPart: '',
    startedAt: null,
    finishedAt: null
  };
}

function loadDotEnv() {
  let text = '';
  try {
    text = readFileSync(ENV_URL, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

async function fetchDigiKey(method, path, body = null, overrides = {}) {
  if (isDemoMode()) {
    return mockResponse(method, path, body, overrides);
  }

  return scheduleDigiKeyRequest(() => fetchDigiKeyOnce(method, path, body, overrides));
}

async function fetchDigiKeyOnce(method, path, body = null, overrides = {}, retryOnAuthFailure = true) {
  const baseUrl = readEnv('DIGIKEY_API_BASE_URL', 'https://api.digikey.com').replace(/\/+$/, '');
  const clientId = readEnv('DIGIKEY_CLIENT_ID', '').trim();
  const language = overrides.localeLanguage ?? readEnv('DIGIKEY_LOCALE_LANGUAGE', 'en');
  const currency = overrides.localeCurrency ?? readEnv('DIGIKEY_LOCALE_CURRENCY', 'USD');
  const site = overrides.localeSite ?? readEnv('DIGIKEY_LOCALE_SITE', 'US');
  const customerId = overrides.customerId ?? (readEnv('DIGIKEY_CUSTOMER_ID', '0').trim() || '0');
  const accountId = overrides.accountId ?? readEnv('DIGIKEY_ACCOUNT_ID', '').trim();

  if (!clientId) {
    return {
      error: 'DIGIKEY_CLIENT_ID is required for live requests. Set MCP_ALLOW_DEMO=true to test without credentials.'
    };
  }

  const accessToken = await getDigiKeyAccessToken();
  if (!accessToken) {
    return {
      error:
        'DIGIKEY_CLIENT_SECRET is required for live DigiKey requests. The app uses DigiKey client_credentials to obtain a bearer token.'
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-DIGIKEY-Client-Id': clientId,
    'X-DIGIKEY-Customer-Id': customerId,
    'X-DIGIKEY-Locale-Language': language,
    'X-DIGIKEY-Locale-Currency': currency,
    'X-DIGIKEY-Locale-Site': site,
    Authorization: `Bearer ${accessToken}`
  };

  if (accountId && (path.includes('/productdetails') || path.includes('/pricing'))) {
    headers['X-DIGIKEY-Account-Id'] = accountId;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(DIGIKEY_FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    return {
      error: `DigiKey request failed before HTTP response: ${describeError(error)}`
    };
  }

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text for non-JSON error payloads.
  }

  if (!response.ok) {
    const result = {
      error: `DigiKey API returned HTTP ${response.status} ${response.statusText}`,
      status: response.status,
      body: parsed
    };

    if (response.status === 401 && retryOnAuthFailure) {
      clearDigiKeyAccessTokenCache();
      return fetchDigiKeyOnce(method, path, body, overrides, false);
    }

    return result;
  }

  return parsed;
}

async function scheduleDigiKeyRequest(task) {
  const previous = digikeyRequestChain;
  let release;
  digikeyRequestChain = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await task();
  } finally {
    await delay(250);
    release();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDigiKeyAccessToken() {
  const cached = digikeyTokenCache;
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.accessToken;
  }

  const clientId = readEnv('DIGIKEY_CLIENT_ID', '').trim();
  const clientSecret = readEnv('DIGIKEY_CLIENT_SECRET', '').trim();
  if (!clientId || !clientSecret) {
    return '';
  }

  const baseUrl = readEnv('DIGIKEY_API_BASE_URL', 'https://api.digikey.com').replace(/\/+$/, '');
  const tokenUrl = new URL('/v1/oauth2/token', new URL(baseUrl).origin).toString();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials'
  });

  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(DIGIKEY_FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`DigiKey token request failed before HTTP response: ${describeError(error)}`);
  }

  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text when DigiKey returns non-JSON.
  }

  if (!response.ok) {
    throw new Error(
      `DigiKey token request failed with HTTP ${response.status} ${response.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`
    );
  }

  const accessToken = String(parsed?.access_token ?? '').trim();
  const expiresIn = Number(parsed?.expires_in);
  if (!accessToken) {
    throw new Error('DigiKey token response did not include an access_token.');
  }

  const expiresAt = now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600) * 1000 - 30_000;
  digikeyTokenCache = {
    accessToken,
    expiresAt: Math.max(expiresAt, now + 30_000)
  };

  return accessToken;
}

function clearDigiKeyAccessTokenCache() {
  digikeyTokenCache = null;
}

function isDemoMode() {
  const value = readEnv('MCP_ALLOW_DEMO', 'true').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function mockResponse(method, path, body, overrides) {
  if (path.includes('/productdetails')) {
    const productNumber = decodeURIComponent(path.split('/').at(-2) ?? 'unknown');
    return {
      productNumber,
      description: `Mock details for ${productNumber}`,
      manufacturerName: 'Demo Components',
      manufacturerProductNumber: productNumber,
      minimumOrderQuantity: 1,
      quantityAvailable: 1000,
      productStatus: 'Active',
      productUrl: `https://www.digikey.com/en/products/detail/demo/${encodeURIComponent(productNumber)}`
    };
  }

  if (path.includes('/pricing')) {
    const productNumber = decodeURIComponent(path.split('/').at(-2) ?? 'unknown');
    return {
      productNumber,
      pricing: [
        { quantity: 1, unitPrice: 1.23, extendedPrice: 1.23, currency: overrides.localeCurrency ?? 'USD' },
        { quantity: 10, unitPrice: 1.1, extendedPrice: 11.0, currency: overrides.localeCurrency ?? 'USD' }
      ]
    };
  }

  if (path.includes('/search/keyword')) {
    const query = typeof body?.Keywords === 'string' ? body.Keywords : 'demo';
    return {
      results: [
        {
          productNumber: `DK-${slugify(query)}-001`,
          manufacturerProductNumber: `MPN-${slugify(query)}-001`,
          description: `Mock search result for ${query}`,
          manufacturerName: 'Demo Components',
          minimumOrderQuantity: 1,
          quantityAvailable: 1000,
          productStatus: 'Active',
          productUrl: `https://www.digikey.com/en/products/detail/demo/${encodeURIComponent(query)}`
        },
        {
          productNumber: `DK-${slugify(query)}-002`,
          manufacturerProductNumber: `MPN-${slugify(query)}-002`,
          description: `Second mock search result for ${query}`,
          manufacturerName: 'Demo Components',
          minimumOrderQuantity: 5,
          quantityAvailable: 350,
          productStatus: 'Active',
          productUrl: `https://www.digikey.com/en/products/detail/demo/${encodeURIComponent(query)}-2`
        }
      ]
    };
  }

  return {};
}

function slugify(value) {
  return (
    String(value)
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'DEMO'
  );
}

function extractPartCandidates(clipText, maxParts) {
  const lines = splitIntoLines(clipText);
  const candidates = [];
  const seen = new Set();
  let foundTabularRows = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const tabularCandidates = extractTabularPartCandidates(line);
    if (tabularCandidates.length > 0) {
      foundTabularRows = true;
      for (const rawCandidate of tabularCandidates) {
        addCandidate(candidates, seen, rawCandidate, line, lineIndex);
      }
      continue;
    }

    const labeled = extractLabeledPartCandidates(line);
    for (const rawCandidate of labeled) {
      addCandidate(candidates, seen, rawCandidate, line, lineIndex);
    }

    const tokenMatches = line.match(/\b[A-Z0-9][A-Z0-9._/-]{2,}[A-Z0-9]\b/gi) ?? [];
    for (const token of tokenMatches) {
      addCandidate(candidates, seen, token, line, lineIndex);
    }
  }

  if (foundTabularRows) {
    return candidates.slice(0, maxParts);
  }

  const fallbackMatches = String(clipText).match(/\b[A-Z0-9][A-Z0-9._/-]{3,}[A-Z0-9]\b/gi) ?? [];
  for (const token of fallbackMatches) {
    addCandidate(candidates, seen, token, '', null);
  }

  return candidates.slice(0, maxParts);
}

function extractTabularPartCandidates(line) {
  const columns = String(line || '')
    .split('\t')
    .map((value) => value.trim())
    .filter(Boolean);

  if (columns.length < 4) {
    return [];
  }

  const itemCode = columns[0] || '';
  const impactedPart = columns[2] || '';
  if (!/^(?:PPS-)?\d{6,}$/i.test(itemCode)) {
    return [];
  }

  return impactedPart ? [impactedPart] : [];
}

function extractLabeledPartCandidates(line) {
  const results = [];
  const patterns = [
    /\b(?:manufacturer\s+part\s+number|mfr\s+part\s+number|mpn|part\s+number|part\s*#|pn)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,}[A-Z0-9])/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(line))) {
      if (match[1]) {
        results.push(match[1]);
      }
    }
  }

  return results;
}

function addCandidate(candidates, seen, rawCandidate, sourceLine, lineIndex) {
  const query = normalizeCandidateQuery(rawCandidate);
  if (!isLikelyPartNumber(query) || seen.has(normalizeQueryKey(query))) {
    return;
  }

  seen.add(normalizeQueryKey(query));
  candidates.push({
    query,
    sourceLine: sourceLine || query,
    lineIndex
  });
}

function normalizeCandidateQuery(value) {
  return String(value || '')
    .trim()
    .replace(/^[\s"'([{<]+|[\s"')\]}>,.;:!?]+$/g, '')
    .toUpperCase();
}

function isLikelyPartNumber(value) {
  const token = normalizeCandidateQuery(value);
  if (!token || token.length < 3) {
    return false;
  }

  if (/^(THE|AND|FOR|WITH|FROM|THAT|THIS|WILL|PLEASE|THANKS|REGARDS|EMAIL|REPLY)$/i.test(token)) {
    return false;
  }

  if (!/[0-9]/.test(token)) {
    return false;
  }

  if (token.includes('HTTP') || token.includes('@') || token.includes('.COM')) {
    return false;
  }

  if (/^(?:PPS-)?\d{6,}$/i.test(token)) {
    return false;
  }

  if (/^(?:QTY|ITEM|PRODUCTS?|DESCRIPTION)$/i.test(token)) {
    return false;
  }

  if (/^(?:SOT|SOD|SC|QFN|VDFN|DFN|TO)-?\d+(?:-\d+)?$/i.test(token)) {
    return false;
  }

  if (/^[A-Z]+\/[A-Z0-9]+$/i.test(token)) {
    return false;
  }

  return /[A-Z]/.test(token) || /^\d{2,}(?:-\d{2,})+$/.test(token) || token.includes('-');
}

function chooseBestCandidate(candidates, query, sourceLine) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {};
  }

  const target = normalizeQueryKey(query);
  const sourceTokens = tokenizeText(sourceLine);
  let bestCandidate = candidates[0] || {};
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const manufacturerPartNumber =
      firstText(candidate, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber']) || '';
    const digiKeyPartNumber = extractDigiKeyProductNumber(candidate) || '';
    const description = extractDigiKeyDescription(candidate) || '';
    const manufacturerName = extractDigiKeyManufacturerName(candidate) || '';
    const candidateTokens = tokenizeText(`${manufacturerPartNumber} ${digiKeyPartNumber} ${description} ${manufacturerName}`);

    let score = 0;
    if (normalizeQueryKey(manufacturerPartNumber) === target) score += 120;
    if (normalizeQueryKey(digiKeyPartNumber) === target) score += 110;
    if (normalizeQueryKey(manufacturerPartNumber).includes(target)) score += 40;
    if (normalizeQueryKey(digiKeyPartNumber).includes(target)) score += 35;
    score += overlapScore(sourceTokens, candidateTokens) * 4;

    const status = extractProductStatusInfo(candidate);
    if (status.status === 'active') {
      score += 10;
    }

    const stock = extractStock(candidate);
    if (Number.isFinite(stock) && stock > 0) {
      score += Math.min(8, Math.max(2, Math.round(stock / 1000)));
    }

    const price = extractUnitPrice(pickPricingTier(extractPricingRows(candidate), 1));
    if (Number.isFinite(price) && price > 0) {
      score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function extractProductItems(data) {
  const array = findBestArray(data, scoreSearchArray);
  return array.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function extractPricingRows(data) {
  const array = findBestArray(data, scorePricingArray);
  const directRows = array.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (directRows.length > 0) {
    return directRows;
  }

  const rows = [];
  for (const variation of extractNestedProductVariations(data)) {
    const pricing = firstValue(variation, ['StandardPricing', 'standardPricing', 'pricing', 'Pricing']);
    if (Array.isArray(pricing)) {
      rows.push(...pricing.filter((item) => item && typeof item === 'object' && !Array.isArray(item)));
    }
  }

  return rows;
}

function extractTechnicalParameters(data) {
  const parameterObjects = findTechnicalParameterObjects(data);
  const seen = new Set();
  const parameters = [];

  for (const entry of parameterObjects) {
    const name = firstText(entry, ['ParameterText', 'parameterText', 'Name', 'name', 'Label', 'label']);
    const value =
      firstText(entry, ['ValueText', 'valueText', 'Value', 'value']) ||
      firstText(entry, ['ValueId', 'valueId']);

    if (!name || !value) {
      continue;
    }

    const dedupeKey = `${normalizeQueryKey(name)}::${String(value).trim()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    parameters.push({
      name,
      value,
      type: firstText(entry, ['ParameterType', 'parameterType', 'Type', 'type']) || ''
    });
  }

  return parameters;
}

function findTechnicalParameterObjects(data, depth = 0) {
  if (depth > 6 || !data || typeof data !== 'object') {
    return [];
  }

  if (Array.isArray(data)) {
    let results = [];
    for (const item of data) {
      results = results.concat(findTechnicalParameterObjects(item, depth + 1));
    }
    return results;
  }

  const direct = firstValue(data, ['Parameters', 'parameters', 'TechnicalParameters', 'technicalParameters']);
  if (Array.isArray(direct)) {
    return direct.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  }

  let results = [];
  for (const value of Object.values(data)) {
    results = results.concat(findTechnicalParameterObjects(value, depth + 1));
  }
  return results;
}

function indexTechnicalParameters(parameters) {
  const index = new Map();

  for (const entry of Array.isArray(parameters) ? parameters : []) {
    const name = String(entry?.name ?? '').trim();
    if (!name) {
      continue;
    }

    const key = normalizeParameterName(name);
    if (!index.has(key)) {
      index.set(key, []);
    }
    index.get(key).push(entry);
  }

  return index;
}

function normalizeParameterName(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTechnicalParameter(index, names) {
  for (const name of names) {
    const key = normalizeParameterName(name);
    const entries = index.get(key);
    if (Array.isArray(entries) && entries.length > 0) {
      return entries[0];
    }
  }
  return null;
}

function comparePackageCompatibility(sourceParameters, candidateParameters, sourceRecord, candidateRecord) {
  const sourcePackage =
    getTechnicalParameter(sourceParameters, ['Package / Case'])?.value ||
    getTechnicalParameter(sourceParameters, ['Supplier Device Package'])?.value ||
    sourceRecord.package ||
    '';
  const candidatePackage =
    getTechnicalParameter(candidateParameters, ['Package / Case'])?.value ||
    getTechnicalParameter(candidateParameters, ['Supplier Device Package'])?.value ||
    candidateRecord.package ||
    '';

  if (!sourcePackage || !candidatePackage) {
    return {
      scoreDelta: 0,
      reason: '',
      review: 'Package comparison is incomplete because one side is missing package data.'
    };
  }

  const exact = normalizeQueryKey(sourcePackage) === normalizeQueryKey(candidatePackage);
  if (exact) {
    return {
      scoreDelta: 18,
      reason: `package matches (${candidatePackage})`,
      review: '',
      exactMatch: true,
      criticalMismatch: false
    };
  }

  const sourceTokens = tokenizeText(sourcePackage);
  const candidateTokens = tokenizeText(candidatePackage);
  const overlap = overlapScore(sourceTokens, candidateTokens);
  if (overlap >= 2) {
    return {
      scoreDelta: 2,
      reason: `package is similar (${sourcePackage} vs ${candidatePackage})`,
      review: 'Package is not exact and should be reviewed.',
      exactMatch: false,
      criticalMismatch: true
    };
  }

  return {
    scoreDelta: -30,
    reason: `package differs (${sourcePackage} vs ${candidatePackage})`,
    review: 'Package mismatch may prevent drop-in replacement.',
    exactMatch: false,
    criticalMismatch: true
  };
}

function compareNamedNumericParameter(sourceParameters, candidateParameters, config) {
  const sourceEntry = getTechnicalParameter(sourceParameters, config.sourceNames);
  const candidateEntry = getTechnicalParameter(candidateParameters, config.candidateNames);

  if (!sourceEntry || !candidateEntry) {
    return {
      scoreDelta: 0,
      reason: '',
      review: `${capitalize(config.label)} comparison is incomplete because one side is missing the parameter.`
    };
  }

  const sourceValue = parseNumericMeasurement(sourceEntry.value);
  const candidateValue = parseNumericMeasurement(candidateEntry.value);
  if (!Number.isFinite(sourceValue.value) || !Number.isFinite(candidateValue.value)) {
    return {
      scoreDelta: 0,
      reason: '',
      review: `${capitalize(config.label)} could not be normalized for comparison.`
    };
  }

  if (config.comparator === 'candidate_gte_source') {
    if (candidateValue.value >= sourceValue.value) {
      return {
        scoreDelta: config.weight,
        reason: `${config.label} meets or exceeds source (${candidateEntry.value} vs ${sourceEntry.value})`,
        review: ''
      };
    }

    return {
      scoreDelta: -config.weight,
      reason: `${config.label} is lower than source (${candidateEntry.value} vs ${sourceEntry.value})`,
      review: `${capitalize(config.label)} may be insufficient.`
    };
  }

  if (config.comparator === 'close_ratio') {
    const reference = Math.max(Math.abs(sourceValue.value), 0.000001);
    const percentDiff = Math.abs(candidateValue.value - sourceValue.value) / reference * 100;
    if (percentDiff <= (config.tolerancePercent ?? 10)) {
      return {
        scoreDelta: config.weight,
        reason: `${config.label} is close to source (${candidateEntry.value} vs ${sourceEntry.value})`,
        review: ''
      };
    }

    if (percentDiff <= (config.tolerancePercent ?? 10) * 2) {
      return {
        scoreDelta: Math.round(config.weight / 2),
        reason: `${config.label} is in the same range (${candidateEntry.value} vs ${sourceEntry.value})`,
        review: `${capitalize(config.label)} should be reviewed for fit.`
      };
    }

    return {
      scoreDelta: -Math.round(config.weight * 0.75),
      reason: `${config.label} differs materially (${candidateEntry.value} vs ${sourceEntry.value})`,
      review: `${capitalize(config.label)} mismatch needs engineering review.`
    };
  }

  return {
    scoreDelta: 0,
    reason: '',
    review: `${capitalize(config.label)} comparison rule is unsupported.`
  };
}

function compareNamedTextParameter(sourceParameters, candidateParameters, config) {
  const sourceEntry = getTechnicalParameter(sourceParameters, config.names);
  const candidateEntry = getTechnicalParameter(candidateParameters, config.names);

  if (!sourceEntry || !candidateEntry) {
    return {
      scoreDelta: 0,
      reason: '',
      review: `${capitalize(config.label)} comparison is incomplete because one side is missing the parameter.`
    };
  }

  const exact = normalizeQueryKey(sourceEntry.value) === normalizeQueryKey(candidateEntry.value);
  if (exact) {
    return {
      scoreDelta: config.weight,
      reason: `${config.label} matches (${candidateEntry.value})`,
      review: '',
      exactMatch: true,
      criticalMismatch: false
    };
  }

  const overlap = overlapScore(tokenizeText(sourceEntry.value), tokenizeText(candidateEntry.value));
  if (overlap >= 1) {
    return {
      scoreDelta: Math.round(config.weight / 2),
      reason: `${config.label} is similar (${candidateEntry.value} vs ${sourceEntry.value})`,
      review: `${capitalize(config.label)} is not exact and should be reviewed.`,
      exactMatch: false,
      criticalMismatch: config.label === 'supplier device package'
    };
  }

  return {
    scoreDelta: -Math.round(config.weight / 2),
    reason: `${config.label} differs (${candidateEntry.value} vs ${sourceEntry.value})`,
    review: `${capitalize(config.label)} mismatch may matter.`,
    exactMatch: false,
    criticalMismatch: config.label === 'supplier device package'
  };
}

function compareTemperatureRange(sourceParameters, candidateParameters, config) {
  const sourceEntry = getTechnicalParameter(sourceParameters, config.names);
  const candidateEntry = getTechnicalParameter(candidateParameters, config.names);

  if (!sourceEntry || !candidateEntry) {
    return {
      scoreDelta: 0,
      reason: '',
      review: 'Operating temperature comparison is incomplete because one side is missing the parameter.'
    };
  }

  const sourceRange = parseTemperatureRange(sourceEntry.value);
  const candidateRange = parseTemperatureRange(candidateEntry.value);
  if (!sourceRange || !candidateRange) {
    return {
      scoreDelta: 0,
      reason: '',
      review: 'Operating temperature range could not be normalized for comparison.'
    };
  }

  if (candidateRange.min <= sourceRange.min && candidateRange.max >= sourceRange.max) {
    return {
      scoreDelta: config.weight,
      reason: `operating temperature covers source (${candidateEntry.value} vs ${sourceEntry.value})`,
      review: ''
    };
  }

  if (candidateRange.max >= sourceRange.max || candidateRange.min <= sourceRange.min) {
    return {
      scoreDelta: Math.round(config.weight / 2),
      reason: `operating temperature is close to source (${candidateEntry.value} vs ${sourceEntry.value})`,
      review: 'Operating temperature range should be reviewed.'
    };
  }

  return {
    scoreDelta: -config.weight,
    reason: `operating temperature is narrower than source (${candidateEntry.value} vs ${sourceEntry.value})`,
    review: 'Operating temperature mismatch may prevent drop-in use.'
  };
}

function buildStatusScoreAdjustment(candidateStatus) {
  const status = String(candidateStatus ?? '').trim().toLowerCase();
  if (!status) {
    return {
      scoreDelta: 0,
      reason: '',
      review: 'Candidate status is unavailable.'
    };
  }

  if (status === 'active') {
    return {
      scoreDelta: 10,
      reason: 'candidate status is active',
      review: ''
    };
  }

  if (status.includes('last time buy')) {
    return {
      scoreDelta: -14,
      reason: 'candidate is also last time buy',
      review: 'Lifecycle status should be reviewed.'
    };
  }

  if (status.includes('obsolete') || status.includes('discontinued') || status.includes('end of life')) {
    return {
      scoreDelta: -35,
      reason: `candidate status is ${candidateStatus}`,
      review: 'Lifecycle status may make this a weak substitute.'
    };
  }

  return {
    scoreDelta: -18,
    reason: `candidate status is ${candidateStatus}`,
    review: 'Lifecycle status may make this a weak substitute.'
  };
}

function buildStockScoreAdjustment(candidateRecord) {
  const stock = Number(candidateRecord?.stock);
  if (!Number.isFinite(stock)) {
    return {
      scoreDelta: 0,
      reason: '',
      review: 'Candidate stock is unavailable.'
    };
  }

  if (stock > 10000) {
    return {
      scoreDelta: 10,
      reason: `${formatNumber(stock)} units in stock`,
      review: ''
    };
  }

  if (stock > 1000) {
    return {
      scoreDelta: 7,
      reason: `${formatNumber(stock)} units in stock`,
      review: ''
    };
  }

  if (stock > 100) {
    return {
      scoreDelta: 2,
      reason: `${formatNumber(stock)} units in stock`,
      review: 'Available stock is limited.'
    };
  }

  if (stock > 0) {
    return {
      scoreDelta: -6,
      reason: `${formatNumber(stock)} units in stock`,
      review: 'Available stock is low.'
    };
  }

  return {
    scoreDelta: -35,
    reason: 'candidate has zero stock',
    review: 'Zero stock weakens the substitute recommendation.'
  };
}

function determineCandidateCategory({ score, candidateStatusText, candidateStock, packageCheck, supplierPackageCheck }) {
  const status = String(candidateStatusText ?? '').trim().toLowerCase();
  const stock = Number(candidateStock);
  const hasCriticalLifecycleRisk =
    status.includes('obsolete') || status.includes('discontinued') || status.includes('end of life');
  const hasZeroStock = Number.isFinite(stock) && stock <= 0;
  const hasDropInPackageRisk = Boolean(packageCheck?.criticalMismatch || supplierPackageCheck?.criticalMismatch);

  if (hasCriticalLifecycleRisk || hasZeroStock) {
    return 'Poor match';
  }

  if (score >= 78 && !hasDropInPackageRisk) {
    return 'Recommended';
  }

  if (score >= 58) {
    return 'Possible with review';
  }

  return 'Poor match';
}

function buildPriceScoreAdjustment(candidateRecord) {
  const unitPrice = Number(candidateRecord?.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return {
      scoreDelta: 0,
      reason: '',
      review: 'Candidate price is unavailable.'
    };
  }

  if (unitPrice <= 5) {
    return {
      scoreDelta: 4,
      reason: `price is ${formatCurrency(unitPrice, candidateRecord.currency)}`,
      review: ''
    };
  }

  if (unitPrice <= 10) {
    return {
      scoreDelta: 2,
      reason: `price is ${formatCurrency(unitPrice, candidateRecord.currency)}`,
      review: ''
    };
  }

  return {
    scoreDelta: -2,
    reason: `price is ${formatCurrency(unitPrice, candidateRecord.currency)}`,
    review: 'Higher unit price should be reviewed.'
  };
}

function parseNumericMeasurement(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  const numericValue = match ? Number(match[0]) : NaN;
  return {
    value: Number.isFinite(numericValue) ? numericValue : NaN,
    unit: extractMeasurementUnit(text)
  };
}

function extractMeasurementUnit(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/[a-zA-Z%]+(?:\/[a-zA-Z%]+)?/);
  return match ? match[0] : '';
}

function parseTemperatureRange(value) {
  const text = String(value ?? '').trim();
  const matches = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (matches.length < 2) {
    return null;
  }

  return {
    min: Math.min(matches[0], matches[1]),
    max: Math.max(matches[0], matches[1])
  };
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function capitalize(value) {
  const text = String(value ?? '');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function coalesceMeaningfulText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text || /^\[object object\]$/i.test(text)) {
      continue;
    }
    return text;
  }
  return '';
}

function extractBestObject(data) {
  if (!data || typeof data !== 'object') {
    return {};
  }

  if (Array.isArray(data)) {
    return (data.find((item) => item && typeof item === 'object' && !Array.isArray(item)) ?? {});
  }

  const arrays = Object.values(data).filter(Array.isArray);
  for (const array of arrays) {
    const item = array.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    if (item) {
      return item;
    }
  }

  return data;
}

function scoreSearchArray(array) {
  let score = 0;
  for (const item of array.slice(0, 6)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    if (firstText(item, ['productNumber', 'ProductNumber', 'manufacturerProductNumber', 'ManufacturerProductNumber', 'description', 'Description'])) {
      score += 8;
    }
    if (firstText(item, ['manufacturerName', 'ManufacturerName'])) {
      score += 3;
    }
    if (extractDigiKeyDescription(item)) {
      score += 3;
    }
  }
  return score;
}

function scorePricingArray(array) {
  let score = 0;
  for (const item of array.slice(0, 8)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    if (firstValue(item, ['quantity', 'Quantity', 'breakQuantity', 'BreakQuantity']) !== undefined) {
      score += 5;
    }
    if (firstValue(item, ['unitPrice', 'UnitPrice', 'price', 'Price']) !== undefined) {
      score += 5;
    }
  }
  return score;
}

function findBestArray(value, scorer, depth = 0) {
  if (depth > 4) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  let bestArray = [];
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const childValue of Object.values(value)) {
    const candidateArrays = Array.isArray(childValue)
      ? [childValue]
      : findNestedArrays(childValue, depth + 1);

    for (const candidate of candidateArrays) {
      const score = scorer(candidate);
      if (score > bestScore) {
        bestScore = score;
        bestArray = candidate;
      }
    }
  }

  return bestArray;
}

function findNestedArrays(value, depth) {
  if (depth > 4) {
    return [];
  }

  if (Array.isArray(value)) {
    return [value];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  const arrays = [];
  for (const childValue of Object.values(value)) {
    arrays.push(...findNestedArrays(childValue, depth + 1));
  }
  return arrays;
}

function extractDigiKeyDescription(object) {
  if (!object || typeof object !== 'object') {
    return '';
  }

  const direct =
    firstText(object, ['description', 'productDescription', 'ProductDescription', 'longDescription', 'LongDescription']) || '';
  if (direct) {
    return direct;
  }

  const descriptionObject = object.Description;
  if (descriptionObject && typeof descriptionObject === 'object' && !Array.isArray(descriptionObject)) {
    return (
      firstText(descriptionObject, ['DetailedDescription', 'ProductDescription', 'detailedDescription', 'productDescription']) || ''
    );
  }

  return '';
}

function extractDigiKeyProductNumber(object) {
  const direct = firstText(object, ['productNumber', 'ProductNumber', 'digiKeyPartNumber', 'DigiKeyPartNumber', 'partNumber', 'PartNumber']) || '';
  if (direct) {
    return direct;
  }

  const variations = extractNestedProductVariations(object);
  for (const variation of variations) {
    const nested = firstText(variation, ['DigiKeyProductNumber', 'digiKeyProductNumber', 'productNumber', 'ProductNumber', 'partNumber', 'PartNumber']) || '';
    if (nested) {
      return nested;
    }
  }

  return '';
}

function extractDigiKeyManufacturerName(object, secondaryObject = null) {
  const extractName = (value) => {
    if (!value || typeof value !== 'object') {
      return '';
    }

    const direct = firstText(value, ['manufacturerName', 'ManufacturerName']) || '';
    if (direct) {
      return direct;
    }

    const manufacturerObject = value.Manufacturer ?? value.manufacturer ?? null;
    if (manufacturerObject && typeof manufacturerObject === 'object' && !Array.isArray(manufacturerObject)) {
      return firstText(manufacturerObject, ['Name', 'name']) || '';
    }

    for (const nestedValue of Object.values(value)) {
      if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
        const nestedName = extractName(nestedValue);
        if (nestedName) {
          return nestedName;
        }
      }
    }

    return '';
  };

  return extractName(object) || extractName(secondaryObject) || '';
}

function extractNestedProductVariations(data) {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const variationSources = [];
  if (Array.isArray(data.Products)) {
    variationSources.push(...data.Products);
  } else {
    variationSources.push(data);
  }

  const variations = [];
  for (const source of variationSources) {
    const nested = firstValue(source, ['ProductVariations', 'productVariations', 'Variations', 'variations']);
    if (Array.isArray(nested)) {
      variations.push(...nested.filter((item) => item && typeof item === 'object' && !Array.isArray(item)));
    }
  }

  return variations;
}

function summarizeProduct(object) {
  return {
    productNumber: extractDigiKeyProductNumber(object),
    manufacturerPartNumber:
      firstText(object, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber']) || '',
    manufacturerName: extractDigiKeyManufacturerName(object),
    description: extractDigiKeyDescription(object),
    productStatus: extractProductStatusInfo(object).status,
    stock: extractStock(object),
    quantityAvailable: extractQuantityAvailable(object),
    productUrl: firstText(object, ['productUrl', 'ProductUrl', 'url', 'Url']) || ''
  };
}

function extractProductStatusInfo(...objects) {
  for (const object of objects) {
    let statusText = firstText(object, ['productStatus', 'status']) || '';
    if (!statusText) {
      const productStatusObject = object?.ProductStatus ?? object?.productStatus ?? null;
      if (productStatusObject && typeof productStatusObject === 'object' && !Array.isArray(productStatusObject)) {
        statusText = firstText(productStatusObject, ['Status', 'status']) || '';
      } else {
        statusText = firstText(object, ['Status']) || '';
      }
    }
    if (statusText) {
      return { status: String(statusText).trim().toLowerCase() };
    }
  }
  return { status: '' };
}

function extractStock(...objects) {
  for (const object of objects) {
    const value = parseInteger(firstValue(object, ['quantityAvailable', 'QuantityAvailable', 'stock', 'Stock', 'inStockQuantity', 'InStockQuantity', 'availableQuantity', 'AvailableQuantity']));
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return '';
}

function extractQuantityAvailable(...objects) {
  for (const object of objects) {
    const value = parseInteger(firstValue(object, ['quantityAvailable', 'QuantityAvailable', 'availableQuantity', 'AvailableQuantity', 'stock', 'Stock']));
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return '';
}

function extractUnitPrice(pricingRow) {
  const value = firstValue(pricingRow, ['unitPrice', 'UnitPrice', 'price', 'Price']);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '';
}

function extractCurrency(...objects) {
  for (const object of objects) {
    const text = firstText(object, ['currency', 'Currency', 'currencyCode', 'CurrencyCode']);
    if (text) {
      return text;
    }
  }
  return readEnv('DIGIKEY_LOCALE_CURRENCY', 'USD');
}

function pickPricingTier(pricingRows, qty) {
  if (!Array.isArray(pricingRows) || pricingRows.length === 0) {
    return {};
  }

  const normalized = pricingRows
    .map((row) => ({
      row,
      breakQty: parseInteger(firstValue(row, ['quantity', 'Quantity', 'breakQuantity', 'BreakQuantity'])) || 1,
      unitPrice: Number(firstValue(row, ['unitPrice', 'UnitPrice', 'price', 'Price']))
    }))
    .filter((entry) => Number.isFinite(entry.unitPrice));

  if (normalized.length === 0) {
    return pricingRows[0] || {};
  }

  normalized.sort((a, b) => a.breakQty - b.breakQty);
  const targetQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
  let chosen = normalized[0];
  for (const entry of normalized) {
    if (entry.breakQty <= targetQty) {
      chosen = entry;
    } else {
      break;
    }
  }
  return chosen.row;
}

function firstText(object, keys) {
  const value = firstValue(object, keys);
  if (value === undefined || value === null) {
    return '';
  }
  const text = String(value).trim();
  return text;
}

function firstValue(object, keys) {
  if (!object || typeof object !== 'object') {
    return undefined;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      const value = object[key];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
  }

  for (const value of Object.values(object)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = firstValue(value, keys);
      if (nested !== undefined && nested !== null && nested !== '') {
        return nested;
      }
    }
  }

  return undefined;
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') {
    return NaN;
  }
  const normalized = String(value).replace(/[^0-9.-]+/g, '');
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? '');
  }
  return new Intl.NumberFormat('en-US').format(number);
}

function formatCurrency(value, currency = 'USD') {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? '');
  }

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD'
    }).format(number);
  } catch {
    return `${currency || 'USD'} ${number.toFixed(2)}`;
  }
}

function inferTechnicalParametersReason({ partNumber, record, raw, technicalParameters }) {
  if (technicalParameters.length > 0) {
    return `Found ${technicalParameters.length} technical parameter${technicalParameters.length === 1 ? '' : 's'}.`;
  }

  const rawResponses = [raw, raw?.searchResponse, raw?.details, raw?.pricing].filter(Boolean);
  for (const response of rawResponses) {
    if (response?.error) {
      return `DigiKey request failed: ${response.error}`;
    }
  }

  if (!record.matchedDigiKeyPartNumber && !record.matchedManufacturerPartNumber) {
    return `No DigiKey match was found for ${partNumber}.`;
  }

  if (record.matchedDigiKeyPartNumber && !hasParameterContainer(raw)) {
    return `DigiKey matched ${record.matchedDigiKeyPartNumber}, but no technical parameters were present in the response.`;
  }

  return `Technical parameters were unavailable for ${partNumber}.`;
}

function hasParameterContainer(data, depth = 0) {
  if (depth > 6 || !data || typeof data !== 'object') {
    return false;
  }

  if (Array.isArray(data)) {
    return data.some((item) => hasParameterContainer(item, depth + 1));
  }

  if (Array.isArray(data.Parameters) || Array.isArray(data.parameters) || Array.isArray(data.TechnicalParameters) || Array.isArray(data.technicalParameters)) {
    return true;
  }

  return Object.values(data).some((value) => hasParameterContainer(value, depth + 1));
}

function overlapScore(sourceTokens, itemTokens) {
  if (!sourceTokens.length || !itemTokens.length) {
    return 0;
  }

  const itemSet = new Set(itemTokens);
  let matches = 0;
  for (const token of sourceTokens) {
    if (itemSet.has(token)) {
      matches += 1;
    }
  }
  return matches;
}

function tokenizeText(value) {
  return normalizeCandidateQuery(value)
    .split(/[^A-Z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function normalizeQueryKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

function hashText(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function appendDebugLog(lines) {
  try {
    const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
    appendFileSync(DEBUG_LOG_URL, `${text}\n`, 'utf8');
  } catch {
    // Debug logging should never break the lookup flow.
  }
}

function stringifyDebugPayload(payload) {
  try {
    return JSON.stringify(payload ?? null, null, 2);
  } catch {
    return String(payload);
  }
}

function splitIntoLines(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function describeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readEnv(key, fallback = '') {
  return process.env[key] ?? fallback;
}

function getDatabase() {
  if (database) {
    return database;
  }

  database = new DatabaseSync(DB_PATH);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS part_records (
      query_key TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      source_line TEXT NOT NULL,
      result_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clip_analyses (
      clip_hash TEXT PRIMARY KEY,
      clip_text TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_part_records_updated_at ON part_records(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_clip_analyses_updated_at ON clip_analyses(updated_at DESC);
  `);
  return database;
}

function isCacheStale(updatedAt) {
  if (!updatedAt) {
    return true;
  }
  const time = new Date(updatedAt).getTime();
  if (!Number.isFinite(time)) {
    return true;
  }
  return Date.now() - time > CACHE_TTL_MS;
}

function getDateCode(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function createLocalServer(port) {
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  return { transport, port };
}

async function main() {
  const mode = (process.argv[2] ?? process.env.MCP_TRANSPORT ?? 'http').toLowerCase();

  if (mode === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const port = Number(readEnv('PORT', '3000'));
  const { transport } = createLocalServer(port);
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`);

    if (requestUrl.pathname === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, mode: 'http' }));
      return;
    }

    if (requestUrl.pathname === '/preview') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(WIDGET_HTML);
      return;
    }

    if (requestUrl.pathname === '/cache/stats') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(getCacheSummary()));
      return;
    }

    if (requestUrl.pathname === '/part-progress') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(partLookupProgress));
      return;
    }

    if (!requestUrl.pathname.startsWith('/mcp')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    transport.handleRequest(req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`Part Scraper MCP server listening on http://127.0.0.1:${port}/mcp`);
  });

  const shutdown = async () => {
    await transport.close().catch(() => {});
    httpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const STOP_WORDS = new Set([
  'AND',
  'ARE',
  'BOM',
  'CAN',
  'FOR',
  'FROM',
  'IN',
  'ITEM',
  'MODEL',
  'NOTE',
  'PART',
  'PLEASE',
  'QTY',
  'QUOTE',
  'RE',
  'REPLY',
  'SUBJECT',
  'THE',
  'THIS',
  'TO',
  'WITH'
]);

await main();
