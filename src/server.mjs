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
const MANUFACTURER_REFERENCE_URL = new URL('../semiconductor_and_ic_manufacturers.md', import.meta.url);
const DB_PATH = fileURLToPath(DB_URL);
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const STOCK_SENSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MANUFACTURER_CAPABILITY_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MANUFACTURER_SCORE_SEED = 50;
const DIGIKEY_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PARTS = 10;
const DEFAULT_MAX_RECOMMENDATIONS = 3;

let digikeyRequestChain = Promise.resolve();
let digikeyTokenCache = null;
let database = null;
let manufacturerReferenceCache = null;
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
  if (cached && !isCacheStale(cached.updatedAt) && isCacheRecordUsableForCurrentMode(cached.record)) {
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

  const normalizedResult = await normalizePartLookupResult({
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

  let cached = cachedBeforeLookup && isCacheRecordUsableForCurrentMode(cachedBeforeLookup.record) ? cachedBeforeLookup : null;
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
      : await fetchDerivedCandidatePartNumbers(
          normalizedSourcePartNumber,
          sourceLookup.record,
          sourceTechnical,
          maxCandidates
        );
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
      stock: sourceLookup.record.stock ?? '',
      quantityAvailable: sourceLookup.record.quantityAvailable ?? '',
      unitPrice: sourceLookup.record.unitPrice ?? '',
      currency: sourceLookup.record.currency || readEnv('DIGIKEY_LOCALE_CURRENCY', 'USD'),
      technicalParameterCount: sourceTechnical.technicalParameters.length,
      technicalParameters: sourceTechnical.technicalParameters,
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
  if (cached && !isCacheRecordUsableForCurrentMode(cached.record)) {
    cached = null;
  }

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

function isCacheRecordUsableForCurrentMode(record) {
  return isDemoMode() || !isDemoPartRecord(record);
}

function isDemoPartRecord(record) {
  const text = [
    record?.manufacturerName,
    record?.matchedManufacturerPartNumber,
    record?.matchedDigiKeyPartNumber,
    record?.description,
    record?.productUrl
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();

  return text.includes('DEMO COMPONENTS') || /\bMPN-[A-Z0-9-]+-001\b/.test(text) || text.includes('/DETAIL/DEMO/');
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

async function fetchDerivedCandidatePartNumbers(sourcePartNumber, sourceRecord, sourceTechnical, maxCandidates) {
  const queries = buildCandidateDiscoveryQueries(
    sourceRecord?.matchedManufacturerPartNumber || sourceRecord?.query || sourcePartNumber,
    sourceRecord,
    sourceTechnical
  );
  const sourceLine = sourceRecord?.description || sourceRecord?.sourceLine || sourcePartNumber;
  const collected = [];

  const strategyCandidates = await discoverCandidatesUsingSearchStrategy(
    sourcePartNumber,
    sourceRecord,
    sourceTechnical,
    {
      maxCandidates,
      existingCandidates: collected
    }
  );
  collected.push(...strategyCandidates);

  for (const query of queries) {
    if (dedupePartNumbers(collected).length >= maxCandidates) {
      break;
    }

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
      searchItems: searchItems.filter((item) => isCandidateSubstituteEligible(item)),
      maxRecommendations: maxCandidates + 2
    });

    collected.push(
      ...fallbackRecommendations.map((item) => item.manufacturerPartNumber || item.productNumber || '')
    );
  }

  return dedupePartNumbers(collected).slice(0, maxCandidates);
}

function buildCandidateDiscoveryQueries(partNumber, sourceRecord = {}, sourceTechnical = {}) {
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

  const sourceDescription = String(sourceTechnical?.description || sourceRecord?.description || '').trim();
  const diodeType = getTechnicalParameter(
    indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []),
    ['Diode Type']
  )?.value;
  const reverseVoltage = getTechnicalParameter(
    indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []),
    ['Voltage - Peak Reverse (Max)']
  )?.value;
  const sourcePackage = getTechnicalParameter(
    indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []),
    ['Supplier Device Package', 'Package / Case']
  )?.value;

  if (sourceDescription) {
    values.push(buildDescriptionDiscoveryPhrase(sourceDescription));
  }

  const technicalPhrase = buildTechnicalDiscoveryPhrase({
    diodeType,
    reverseVoltage,
    sourcePackage
  });
  if (technicalPhrase) {
    values.push(technicalPhrase);
  }

  return dedupePartNumbers(values);
}

function buildDescriptionDiscoveryPhrase(description) {
  const text = String(description || '').toUpperCase();
  const keepers = [];
  if (text.includes('RF DIODE')) keepers.push('RF DIODE');
  if (text.includes('VARACTOR')) keepers.push('VARACTOR');
  if (text.includes('PIN')) keepers.push('PIN');
  if (text.includes('STANDARD')) keepers.push('STANDARD');
  const voltageMatch = text.match(/\b\d+\s*V\b/);
  if (voltageMatch) keepers.push(voltageMatch[0].replace(/\s+/g, ''));
  const packageMatch = text.match(/\b(?:SOT-\d+-\d|SOT-\d+|SC-\d+|0402|0603|SOD-\d+)\b/);
  if (packageMatch) keepers.push(packageMatch[0]);
  return keepers.join(' ').trim();
}

function buildTechnicalDiscoveryPhrase({ diodeType, reverseVoltage, sourcePackage }) {
  const tokens = [];
  const diodeText = String(diodeType || '').toUpperCase();
  if (diodeText.includes('PIN')) tokens.push('PIN');
  if (diodeText.includes('STANDARD')) tokens.push('STANDARD');
  if (diodeText.includes('SINGLE')) tokens.push('SINGLE');
  const voltageText = String(reverseVoltage || '').toUpperCase().replace(/\s+/g, '');
  if (/\d+V/.test(voltageText)) tokens.push(voltageText.match(/\d+V/)[0]);
  const packageText = String(sourcePackage || '').toUpperCase();
  const packageMatch = packageText.match(/\b(?:SOT-\d+-\d|SOT-\d+|SC-\d+|0402|0603|SOD-\d+)\b/);
  if (packageMatch) tokens.push(packageMatch[0]);
  if (!tokens.length) {
    return '';
  }
  tokens.unshift('RF DIODE');
  return tokens.join(' ').trim();
}

function isCandidateSubstituteEligible(item) {
  const manufacturerPartNumber = normalizeCandidateQuery(
    firstText(item, ['manufacturerProductNumber', 'ManufacturerProductNumber', 'manufacturerPartNumber', 'ManufacturerPartNumber'])
  );
  const description = String(extractDigiKeyDescription(item) || '').toUpperCase();
  const productNumber = normalizeCandidateQuery(extractDigiKeyProductNumber(item));
  const combined = `${manufacturerPartNumber} ${description} ${productNumber}`;
  const productStatus = extractProductStatusInfo(item).status;

  if (!combined.trim()) {
    return true;
  }

  if (/\bEVB\b/.test(combined) || /\bEVAL\b/.test(combined) || /\bKIT\b/.test(combined) || /\bBOARD\b/.test(combined)) {
    return false;
  }

  if (isExcludedLifecycleStatus(productStatus)) {
    return false;
  }

  return true;
}

async function discoverCandidatesUsingSearchStrategy(
  sourcePartNumber,
  sourceRecord,
  sourceTechnical,
  { maxCandidates, existingCandidates = [] } = {}
) {
  const partType = classifyPartType(sourceRecord, sourceTechnical);
  const manufacturerPlan = buildManufacturerSearchPlan(partType, sourceTechnical, {
    maxManufacturers: readIntegerEnv('MAX_MANUFACTURER_SEARCHES_PER_DISCOVERY', 24)
  });
  const collected = [...existingCandidates];
  const collectedKeys = new Set(dedupePartNumbers(collected).map((partNumber) => normalizeQueryKey(partNumber)));
  const sourceLine = sourceRecord?.description || sourceRecord?.sourceLine || sourcePartNumber;

  appendDebugLog([
    `Strategy discovery: ${sourcePartNumber}`,
    `Part type: ${partType.partType}`,
    `Part type confidence: ${partType.confidence}`,
    `Manufacturer searches planned: ${manufacturerPlan.length}`,
    ''
  ]);

  for (const planEntry of manufacturerPlan) {
    if (collectedKeys.size >= maxCandidates) {
      break;
    }

    const queries = buildManufacturerSearchQueries(planEntry.manufacturerName, partType, sourceTechnical);
    for (const query of queries.slice(0, 2)) {
      if (collectedKeys.size >= maxCandidates) {
        break;
      }

      const attemptBase = {
        manufacturerName: planEntry.manufacturerName,
        manufacturerKey: planEntry.manufacturerKey,
        partType: partType.partType,
        partTypeKey: partType.partTypeKey,
        packageFamily: buildPackageFamily(sourceTechnical),
        electricalClass: buildElectricalClassKey(sourceTechnical),
        sourcePartNumber,
        sourceTechnicalSummary: buildPartTypeTechnicalSummary(sourceTechnical),
        searchQuery: query,
        searchSource: 'digikey'
      };

      try {
        const searchRequestBody = {
          Keywords: query,
          RecordCount: Math.max(maxCandidates + 6, 10)
        };
        const searchResponse = await fetchDigiKey('POST', '/products/v4/search/keyword', searchRequestBody);
        const searchItems = extractProductItems(searchResponse);
        const selected = chooseBestCandidate(searchItems, query, sourceLine);
        const eligibleItems = searchItems.filter((item) => isCandidateSubstituteEligible(item));
        const recommendations = buildRecommendations({
          sourceQuery: query,
          sourceLine,
          selected,
          searchItems: eligibleItems,
          maxRecommendations: maxCandidates + 2
        });
        const classification = classifyManufacturerSearchResult({
          searchItems,
          recommendations,
          partType
        });
        const attempt = {
          ...attemptBase,
          candidatePartNumbers: recommendations
            .map((item) => item.manufacturerPartNumber || item.productNumber || '')
            .filter(Boolean),
          candidateCount: recommendations.length,
          activeCandidateCount: recommendations.filter((item) => normalizeLifecycleStatus(item.productStatus) === 'active').length,
          inStockCandidateCount: recommendations.filter((item) => Number(item.stock) > 0).length,
          rejectedCandidateCount: Math.max(0, searchItems.length - eligibleItems.length),
          resultClassification: classification.resultClassification,
          reason: classification.reason,
          raw: {
            manufacturerPlan: planEntry,
            searchRequestBody,
            searchResponse
          }
        };

        saveManufacturerSearchAttempt(attempt);
        updateManufacturerCapabilityScoreFromAttempt(attempt);

        for (const partNumber of attempt.candidatePartNumbers) {
          const normalized = normalizeCandidateQuery(partNumber);
          const key = normalizeQueryKey(normalized);
          if (!key || collectedKeys.has(key) || key === normalizeQueryKey(sourcePartNumber)) {
            continue;
          }
          collectedKeys.add(key);
          collected.push(normalized);
        }
      } catch (error) {
        const attempt = {
          ...attemptBase,
          candidatePartNumbers: [],
          candidateCount: 0,
          activeCandidateCount: 0,
          inStockCandidateCount: 0,
          rejectedCandidateCount: 0,
          resultClassification: 'error',
          reason: describeError(error),
          raw: {
            manufacturerPlan: planEntry,
            error: describeError(error)
          }
        };
        saveManufacturerSearchAttempt(attempt);
        updateManufacturerCapabilityScoreFromAttempt(attempt);
      }
    }
  }

  return dedupePartNumbers(collected).slice(0, maxCandidates);
}

function classifyPartType(sourceRecord = {}, sourceTechnical = {}) {
  const parameters = indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []);
  const diodeType = getTechnicalParameter(parameters, ['Diode Type'])?.value || '';
  const description = [
    sourceTechnical?.description,
    sourceRecord?.description,
    sourceRecord?.sourceLine,
    sourceRecord?.category,
    diodeType
  ].filter(Boolean).join(' ');
  const text = description.toUpperCase();

  let partType = 'semiconductor component';
  let confidence = 'low';
  if (text.includes('VARACTOR') || text.includes('VARICAP') || text.includes('VARIABLE CAPACITANCE')) {
    partType = 'varactor diode';
    confidence = 'high';
  } else if (text.includes('LIMITER') && text.includes('DIODE')) {
    partType = 'RF limiter diode';
    confidence = 'high';
  } else if (text.includes('PIN') && text.includes('DIODE')) {
    partType = 'RF PIN diode';
    confidence = 'high';
  } else if (text.includes('SCHOTTKY') && text.includes('DIODE')) {
    partType = 'Schottky diode';
    confidence = 'medium';
  } else if (text.includes('STEP') && text.includes('RECOVERY') && text.includes('DIODE')) {
    partType = 'step-recovery diode';
    confidence = 'high';
  } else if (text.includes('RF DIODE') || text.includes('DIODE')) {
    partType = 'RF diode';
    confidence = 'medium';
  } else if (text.includes('MOSFET')) {
    partType = 'MOSFET';
    confidence = 'medium';
  } else if (text.includes('TVS') || text.includes('PROTECTION DIODE')) {
    partType = 'TVS / protection diode';
    confidence = 'medium';
  } else if (text.includes('OP AMP') || text.includes('OPAMP') || text.includes('AMPLIFIER')) {
    partType = text.includes('RF') || text.includes('MMIC') ? 'RF amplifier / MMIC' : 'op amp';
    confidence = 'medium';
  } else if (text.includes('MICROCONTROLLER') || text.includes('MCU')) {
    partType = 'microcontroller';
    confidence = 'medium';
  }

  return {
    partType,
    partTypeKey: normalizePartType(partType),
    confidence,
    sourceText: description
  };
}

function normalizePartType(partType) {
  return normalizeQueryKey(partType);
}

function buildPartTypeTechnicalSummary(sourceTechnical = {}) {
  const parameters = indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []);
  const values = [
    sourceTechnical?.description,
    getTechnicalParameter(parameters, ['Diode Type'])?.value,
    getTechnicalParameter(parameters, ['Voltage - Peak Reverse (Max)'])?.value,
    getTechnicalParameter(parameters, ['Capacitance @ Vr, F'])?.value,
    getTechnicalParameter(parameters, ['Package / Case'])?.value,
    getTechnicalParameter(parameters, ['Supplier Device Package'])?.value
  ].filter(Boolean);
  return values.join(' | ');
}

function calculatePartTypeConfidence(sourceRecord, sourceTechnical) {
  return classifyPartType(sourceRecord, sourceTechnical).confidence;
}

function loadManufacturerReference() {
  if (manufacturerReferenceCache) {
    return manufacturerReferenceCache;
  }

  let text = '';
  try {
    text = readFileSync(MANUFACTURER_REFERENCE_URL, 'utf8');
  } catch {
    manufacturerReferenceCache = [];
    return manufacturerReferenceCache;
  }

  const entries = [];
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const heading = line.match(/^##+\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (line.startsWith('|') && !/^\|\s*-+/.test(line)) {
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length >= 2 && !/^manufacturer$/i.test(cells[0])) {
        entries.push({
          manufacturerName: cells[0],
          manufacturerKey: normalizeManufacturerKey(cells[0]),
          productAreas: cells.slice(1).join(' | '),
          section
        });
      }
      continue;
    }
    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet) {
      entries.push({
        manufacturerName: bullet[1].trim(),
        manufacturerKey: normalizeManufacturerKey(bullet[1]),
        productAreas: section,
        section
      });
    }
  }

  const seen = new Set();
  manufacturerReferenceCache = entries.filter((entry) => {
    if (!entry.manufacturerKey || seen.has(`${entry.manufacturerKey}:${entry.section}`)) {
      return false;
    }
    seen.add(`${entry.manufacturerKey}:${entry.section}`);
    return true;
  });
  return manufacturerReferenceCache;
}

function extractManufacturersForPartType(partType, manufacturerReference = loadManufacturerReference()) {
  const tokens = tokenizeText(partType?.partType || partType);
  const scored = manufacturerReference.map((entry) => {
    const text = `${entry.section} ${entry.productAreas}`;
    const score = overlapScore(tokens, tokenizeText(text));
    return { ...entry, relevanceScore: score };
  });
  const relevant = scored.filter((entry) => entry.relevanceScore > 0);
  return (relevant.length ? relevant : scored).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function buildManufacturerSearchPlan(partType, sourceTechnical, { maxManufacturers = 24 } = {}) {
  const manufacturers = extractManufacturersForPartType(partType);
  const packageFamily = buildPackageFamily(sourceTechnical);
  const electricalClass = buildElectricalClassKey(sourceTechnical);
  const rows = manufacturers.map((entry) => {
    const scoreRow = getManufacturerCapabilityScore(entry.manufacturerKey, partType.partTypeKey, packageFamily);
    return {
      ...entry,
      partType: partType.partType,
      partTypeKey: partType.partTypeKey,
      packageFamily,
      electricalClass,
      capabilityScore: scoreRow?.score ?? MANUFACTURER_SCORE_SEED,
      confidenceLevel: scoreRow?.confidenceLevel ?? 'low',
      exclusionStatus: scoreRow?.exclusionStatus ?? 'active',
      lastSearchedAt: scoreRow?.lastSearchedAt ?? ''
    };
  });

  return rows
    .filter((entry) => shouldSearchManufacturerForPartType(entry))
    .sort((a, b) => {
      if (b.capabilityScore !== a.capabilityScore) return b.capabilityScore - a.capabilityScore;
      return b.relevanceScore - a.relevanceScore;
    })
    .slice(0, maxManufacturers);
}

function shouldSearchManufacturerForPartType(manufacturerScore) {
  if (!manufacturerScore) {
    return true;
  }
  if (manufacturerScore.exclusionStatus !== 'excluded') {
    return true;
  }
  return !isManufacturerCapabilityFresh(manufacturerScore.lastSearchedAt);
}

function buildManufacturerSearchQueries(manufacturer, partType, sourceTechnical = {}) {
  const technicalPhrase = buildTechnicalSearchPhrase(sourceTechnical);
  const packagePhrase = buildPackageSearchPhrase(sourceTechnical);
  return [
    `${manufacturer} ${partType.partType} ${technicalPhrase}`.trim(),
    `${manufacturer} ${partType.partType} ${packagePhrase}`.trim(),
    `${manufacturer} ${partType.partType} substitute`.trim()
  ].filter(Boolean);
}

function buildTechnicalSearchPhrase(sourceTechnical = {}) {
  const parameters = indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []);
  const values = [
    getTechnicalParameter(parameters, ['Diode Type'])?.value,
    getTechnicalParameter(parameters, ['Voltage - Peak Reverse (Max)'])?.value,
    getTechnicalParameter(parameters, ['Capacitance @ Vr, F'])?.value
  ].filter(Boolean);
  return values.join(' ');
}

function buildPackageSearchPhrase(sourceTechnical = {}) {
  const parameters = indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []);
  return (
    getTechnicalParameter(parameters, ['Supplier Device Package'])?.value ||
    getTechnicalParameter(parameters, ['Package / Case'])?.value ||
    ''
  );
}

function buildElectricalClassKey(sourceTechnical = {}) {
  const phrase = buildTechnicalSearchPhrase(sourceTechnical);
  return normalizeQueryKey(phrase).slice(0, 80);
}

function buildPackageFamily(sourceTechnical = {}) {
  const packageText = buildPackageSearchPhrase(sourceTechnical).toUpperCase();
  const match = packageText.match(/\b(?:SOT-\d+-\d|SOT-\d+|SC-\d+|0402|0603|SOD-\d+|QFN|DFN|TO-\d+)\b/);
  return match ? match[0] : packageText.split(/[,\s]+/).filter(Boolean)[0] || '';
}

function classifyManufacturerSearchResult({ searchItems = [], recommendations = [], partType }) {
  if (recommendations.length > 0) {
    return {
      resultClassification: 'success',
      reason: `Found ${recommendations.length} candidate${recommendations.length === 1 ? '' : 's'} for ${partType.partType}.`
    };
  }

  const related = searchItems.some((item) => isSamePracticalPartType(partType, item));
  if (related) {
    return {
      resultClassification: 'partial',
      reason: 'Found related products, but no clear viable candidate.'
    };
  }

  return {
    resultClassification: 'miss',
    reason: `No products found for ${partType.partType}.`
  };
}

function isCompletedSearchAttempt(resultClassification) {
  return ['success', 'miss', 'partial'].includes(resultClassification);
}

function isManufacturerSearchMiss(resultClassification) {
  return resultClassification === 'miss';
}

function isManufacturerSearchError(resultClassification) {
  return resultClassification === 'error';
}

function filterViableSubstituteCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => !rejectCandidateWithReason(candidate).rejected);
}

function rejectCandidateWithReason(candidate) {
  const status = candidate?.productStatus || extractProductStatusInfo(candidate).status;
  if (isExcludedLifecycleStatus(status)) {
    return {
      rejected: true,
      reason: getExcludedLifecycleReason(status)
    };
  }
  if (!isCandidateSubstituteEligible(candidate)) {
    return {
      rejected: true,
      reason: 'Candidate is an eval board, kit, module, unrelated assembly, or otherwise ineligible.'
    };
  }
  return { rejected: false, reason: '' };
}

function isPackageCompatible(sourceTechnical, candidateTechnical) {
  const sourceParameters = indexTechnicalParameters(sourceTechnical?.technicalParameters ?? []);
  const candidateParameters = indexTechnicalParameters(candidateTechnical?.technicalParameters ?? []);
  return !comparePackageCompatibility(sourceParameters, candidateParameters, {}, {}).criticalMismatch;
}

function isSamePracticalPartType(partType, candidate) {
  const text = `${extractDigiKeyDescription(candidate)} ${firstText(candidate, ['Category', 'category']) || ''}`.toUpperCase();
  const type = String(partType?.partType || partType || '').toUpperCase();
  if (!type || !text) {
    return false;
  }
  if (type.includes('VARACTOR')) return text.includes('VARACTOR') || text.includes('VARIABLE CAPACITANCE');
  if (type.includes('PIN')) return text.includes('PIN') && text.includes('DIODE');
  if (type.includes('LIMITER')) return text.includes('LIMITER') && text.includes('DIODE');
  if (type.includes('SCHOTTKY')) return text.includes('SCHOTTKY');
  if (type.includes('DIODE')) return text.includes('DIODE');
  if (type.includes('MOSFET')) return text.includes('MOSFET');
  if (type.includes('AMPLIFIER') || type.includes('MMIC')) return text.includes('AMPLIFIER') || text.includes('MMIC');
  return overlapScore(tokenizeText(type), tokenizeText(text)) >= 1;
}

function normalizeLifecycleStatus(status) {
  return String(status || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isExcludedLifecycleStatus(status) {
  const normalized = normalizeLifecycleStatus(status);
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('obsolete') ||
    normalized.includes('discontinued') ||
    normalized.includes('end of life') ||
    normalized === 'eol' ||
    normalized.includes('not recommended for new design') ||
    normalized.includes('not for new design') ||
    normalized === 'nrnd' ||
    normalized.includes('last time buy') ||
    normalized.includes('last time purchase')
  );
}

function getExcludedLifecycleReason(status) {
  return isExcludedLifecycleStatus(status) ? `Excluded lifecycle status: ${status}` : '';
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
  const hasCriticalTechnicalGaps = hasCriticalTechnicalReviewGaps(reviewNotes);
  const category = determineCandidateCategory({
    score: normalizedScore,
    candidateStatusText,
    candidateStock: candidateRecord?.stock,
    packageCheck,
    supplierPackageCheck,
    hasCriticalTechnicalGaps
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

async function normalizePartLookupResult({
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
  const recommendedSubstitutes = await buildValidatedRecommendations({
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

async function buildValidatedRecommendations({ sourceQuery, sourceLine, selected, searchItems, maxRecommendations }) {
  const initialRecommendations = buildRecommendations({
    sourceQuery,
    sourceLine,
    selected,
    searchItems,
    maxRecommendations: Math.max(maxRecommendations * 2, maxRecommendations + 2)
  });

  if (!initialRecommendations.length) {
    return [];
  }

  const validated = [];
  const accountId = readEnv('DIGIKEY_ACCOUNT_ID', '').trim();

  for (const item of initialRecommendations) {
    if (isMarketplaceStyleCandidate(item)) {
      continue;
    }

    const productNumber = normalizeCandidateQuery(item.productNumber);
    if (!productNumber) {
      continue;
    }

    let details = {};
    let pricing = {};
    try {
      details = await fetchDigiKey('GET', `/products/v4/search/${encodeURIComponent(productNumber)}/productdetails`, null, {
        accountId
      });
      pricing = await fetchDigiKey('GET', `/products/v4/search/${encodeURIComponent(productNumber)}/pricing`, null, {
        accountId
      });
    } catch {
      continue;
    }

    const bestDetails = extractBestObject(details);
    const validatedStatus = extractProductStatusInfo(bestDetails, details, item).status;
    if (isExcludedLifecycleStatus(validatedStatus)) {
      continue;
    }
    if (isMarketplaceStyleCandidate(bestDetails, details, item)) {
      continue;
    }

    const pricingRows = extractPricingRows(pricing);
    const bestPricingRow = pickPricingTier(pricingRows, 1) || pricingRows[0] || {};
    validated.push({
      ...item,
      manufacturerName: extractDigiKeyManufacturerName(bestDetails, item) || item.manufacturerName,
      description: extractDigiKeyDescription(bestDetails, item) || item.description,
      package: firstText(bestDetails, ['package', 'Package', 'packageType', 'PackageType']) || item.package,
      productStatus: validatedStatus || item.productStatus,
      stock: extractStock(bestDetails, details, item),
      quantityAvailable: extractQuantityAvailable(bestDetails, details, item),
      unitPrice: extractUnitPrice(bestPricingRow),
      currency: extractCurrency(bestPricingRow, bestDetails, details, item),
      productUrl: firstText(bestDetails, ['productUrl', 'ProductUrl', 'url', 'Url']) || item.productUrl
    });

    if (validated.length >= maxRecommendations) {
      break;
    }
  }

  return validated.slice(0, maxRecommendations).map((item, index) => ({
    ...item,
    rank: index + 1,
    confidence: item.score >= 35 ? 'high' : item.score >= 20 ? 'medium' : 'low'
  }));
}

function isMarketplaceStyleCandidate(...objects) {
  const pending = [...objects];
  const seen = new Set();

  while (pending.length) {
    const object = pending.shift();
    if (!object || typeof object !== 'object' || seen.has(object)) {
      continue;
    }
    seen.add(object);

    const marketplaceFlag = firstValue(object, ['MarketPlace', 'Marketplace', 'marketPlace', 'marketplace', 'IsMarketPlace', 'IsMarketplace']);
    if (marketplaceFlag === true || String(marketplaceFlag || '').toLowerCase() === 'true') {
      return true;
    }

    const sellerName =
      firstText(object, ['SellerName', 'sellerName', 'DistributorName', 'distributorName', 'Name']) ||
      firstText(object?.Supplier, ['Name']) ||
      firstText(object?.supplier, ['Name']);
    if (sellerName && /rochester/i.test(sellerName)) {
      return true;
    }

    const productUrl = firstText(object, ['productUrl', 'ProductUrl', 'url', 'Url']);
    if (productUrl && /rochester-electronics/i.test(productUrl)) {
      return true;
    }

    for (const value of Object.values(object)) {
      if (!value) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry && typeof entry === 'object') {
            pending.push(entry);
          }
        }
        continue;
      }
      if (typeof value === 'object') {
        pending.push(value);
      }
    }
  }

  return false;
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
      if (isExcludedLifecycleStatus(productStatus.status)) {
        return null;
      }
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
      ? part.recommendations
          .map((entry) =>
            formatManufacturerPartLabel(
              entry.manufacturerName,
              entry.matchedDigiKeyPartNumber || entry.productNumber || entry.manufacturerPartNumber || ''
            )
          )
          .filter(Boolean)
          .join(', ')
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

  lines.push('', renderSideBySideSubstitutionTable(result));
  return lines.join('\n');
}

function renderSideBySideSubstitutionTable(result) {
  const sourceLabel = formatManufacturerPartLabel(
    result.sourceMatch?.manufacturerName,
    result.sourceMatch?.manufacturerPartNumber || result.sourcePartNumber
  );
  const candidates = result.candidates ?? [];
  const header = ['', 'Original Email Part', ...candidates.map((_, index) => `Candidate ${index + 1}`)];
  const rows = [
    ['Part', sourceLabel, ...candidates.map((candidate) => formatManufacturerPartLabel(candidate.manufacturerName, candidate.candidatePartNumber))],
    ['Category', 'Source part', ...candidates.map((candidate) => candidate.category || '')],
    ['Score', '', ...candidates.map((candidate) => String(candidate.score ?? ''))],
    ['Category Explanation', 'Original part from the pasted email clip; used as the comparison baseline.', ...candidates.map((candidate) => explainCandidateCategory(candidate))],
    ['Stock', formatNumberOrText(result.sourceMatch?.stock), ...candidates.map((candidate) => formatNumberOrText(candidate.stock))],
    ['Status', result.sourceMatch?.productStatus || '', ...candidates.map((candidate) => candidate.productStatus || '')],
    ['Key Parameters', summarizeTechnicalParameters(result.sourceMatch?.technicalParameters), ...candidates.map((candidate) => summarizeTechnicalParameters(candidate.technicalParameters))],
    ['Package', extractPackageSummary(result.sourceMatch?.technicalParameters), ...candidates.map((candidate) => extractPackageSummary(candidate.technicalParameters))],
    ['Reasons', '', ...candidates.map((candidate) => joinCellList(candidate.reasons))],
    ['Review Notes', result.sourceMatch?.reason || '', ...candidates.map((candidate) => joinCellList(candidate.reviewNotes))]
  ];

  return [
    `| ${header.map(escapeMarkdownTableCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownTableCell).join(' | ')} |`)
  ].join('\n');
}

function explainCandidateCategory(candidate) {
  const category = String(candidate?.category || '').trim();
  const score = Number(candidate?.score);
  const scoreText = Number.isFinite(score) ? ` Score ${score}/100.` : '';

  if (category === 'Recommended') {
    return `Best fit found so far; key drop-in checks look acceptable, but engineering review is still required.${scoreText}`;
  }

  if (category === 'Possible with review') {
    return `Potential substitute, but one or more electrical, package, lifecycle, stock, or data-completeness items need review before use.${scoreText}`;
  }

  if (category === 'Poor match') {
    const drivers = getCategoryExplanationDrivers(candidate);
    return `Not a strong drop-in substitute${drivers.length ? ` because: ${drivers.join('; ')}` : ''}.${scoreText}`;
  }

  return category ? `Category assigned by the ranking engine.${scoreText}` : '';
}

function getCategoryExplanationDrivers(candidate) {
  const drivers = [];
  const evidenceLines = [
    ...(Array.isArray(candidate?.reviewNotes) ? candidate.reviewNotes : []),
    ...(Array.isArray(candidate?.reasons) ? candidate.reasons : [])
  ].map((value) => String(value || '').toLowerCase());
  const status = String(candidate?.productStatus || '').trim();
  const stock = Number(candidate?.stock);
  const score = Number(candidate?.score);

  if (status && isExcludedLifecycleStatus(status)) {
    drivers.push(`lifecycle status is ${status}`);
  }

  if (Number.isFinite(stock) && stock <= 0) {
    drivers.push('zero stock');
  }

  if (hasEvidence(evidenceLines, [/\bpackage\b.*\b(mismatch|differs|different|not exact)\b/, /\bsupplier device package\b.*\b(mismatch|differs|different|not exact)\b/])) {
    drivers.push('package mismatch');
  }

  const technicalDrivers = [];
  if (hasEvidence(evidenceLines, [/reverse voltage .*insufficient/, /reverse voltage is lower/])) {
    technicalDrivers.push('reverse voltage may be insufficient');
  }
  if (hasEvidence(evidenceLines, [/capacitance .*mismatch/, /capacitance differs materially/, /capacitance ratio .*mismatch/, /capacitance ratio differs materially/])) {
    technicalDrivers.push('capacitance mismatch');
  }
  if (hasEvidence(evidenceLines, [/diode type .*not exact/, /diode type is similar/, /diode type .*mismatch/])) {
    technicalDrivers.push('diode type is not exact');
  }
  if (hasEvidence(evidenceLines, [/operating temperature .*mismatch/, /operating temperature is narrower/])) {
    technicalDrivers.push('operating temperature range is narrower or mismatched');
  }
  if (hasEvidence(evidenceLines, [/reverse voltage .*incomplete/, /capacitance .*incomplete/, /diode type .*incomplete/, /operating temperature .*incomplete/])) {
    technicalDrivers.push('critical comparison data is incomplete');
  }

  if (technicalDrivers.length) {
    drivers.push(`technical review flags: ${dedupeStrings(technicalDrivers).join(', ')}`);
  }

  if (Number.isFinite(score) && score < 58) {
    drivers.push('score is below the Possible with review threshold');
  }

  return dedupeStrings(drivers);
}

function hasEvidence(evidenceLines, patterns) {
  return evidenceLines.some((line) => patterns.some((pattern) => pattern.test(line)));
}

function formatManufacturerPartLabel(manufacturerName, partNumber) {
  const manufacturer = String(manufacturerName || '').trim();
  const part = String(partNumber || '').trim();
  if (manufacturer && part) {
    return `${manufacturer} - ${part}`;
  }
  return part || manufacturer || '';
}

function summarizeTechnicalParameters(parameters) {
  const index = indexTechnicalParameters(parameters ?? []);
  const values = [
    getTechnicalParameter(index, ['Diode Type'])?.value,
    getTechnicalParameter(index, ['Voltage - Peak Reverse (Max)'])?.value,
    getTechnicalParameter(index, ['Capacitance @ Vr, F'])?.value,
    getTechnicalParameter(index, ['Capacitance Ratio'])?.value,
    getTechnicalParameter(index, ['Operating Temperature'])?.value
  ].filter(Boolean);
  return values.join('; ');
}

function extractPackageSummary(parameters) {
  const index = indexTechnicalParameters(parameters ?? []);
  const values = [
    getTechnicalParameter(index, ['Package / Case'])?.value,
    getTechnicalParameter(index, ['Supplier Device Package'])?.value
  ].filter(Boolean);
  return values.join('; ');
}

function joinCellList(values) {
  return (Array.isArray(values) ? values : []).filter(Boolean).join('; ');
}

function formatNumberOrText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? formatNumber(number) : String(value || '');
}

function escapeMarkdownTableCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

function renderLegacySubstituteRankingSummary(result) {
  const lines = [];
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
  const cachedResult = sanitizeCachedPartResult(result);
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
      resultJson: JSON.stringify(cachedResult),
      rawJson: JSON.stringify(raw),
      updatedAt: now
    });
}

function sanitizeCachedPartResult(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }
  const sanitized = { ...result };
  if (Array.isArray(sanitized.recommendations)) {
    sanitized.recommendations = sanitized.recommendations.map(stripVolatileRecommendationFields);
  }
  if (Array.isArray(sanitized.recommendedSubstitutes)) {
    sanitized.recommendedSubstitutes = sanitized.recommendedSubstitutes.map(stripVolatileRecommendationFields);
  }
  return sanitized;
}

function stripVolatileRecommendationFields(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') {
    return recommendation;
  }
  const {
    score,
    reason,
    confidence,
    category,
    categoryExplanation,
    reasons,
    reviewNotes,
    ...stableFields
  } = recommendation;
  return stableFields;
}

function storeClipAnalysis(clipText, analysis) {
  const now = new Date().toISOString();
  const clipHash = hashText(clipText);
  const cachedAnalysis = sanitizeCachedClipAnalysis(analysis);
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
      analysisJson: JSON.stringify(cachedAnalysis),
      updatedAt: now
    });
}

function sanitizeCachedClipAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    return analysis;
  }
  return {
    ...analysis,
    parts: Array.isArray(analysis.parts) ? analysis.parts.map(sanitizeCachedPartResult) : analysis.parts
  };
}

function getManufacturerCapabilityScore(manufacturerKey, partTypeKey, packageFamily = '') {
  const row = getDatabase()
    .prepare(
      `
      SELECT
        manufacturer_name,
        manufacturer_key,
        part_type,
        part_type_key,
        package_family,
        electrical_class,
        score,
        confidence_level,
        attempt_count,
        miss_count,
        success_count,
        active_candidate_count,
        in_stock_candidate_count,
        exclusion_status,
        reason_for_exclusion,
        first_searched_at,
        last_searched_at,
        last_successful_search_at
      FROM manufacturer_capability_scores
      WHERE manufacturer_key = ?
        AND part_type_key = ?
        AND package_family = ?
    `
    )
    .get(manufacturerKey, partTypeKey, packageFamily);

  if (!row) {
    return null;
  }

  return {
    manufacturerName: row.manufacturer_name,
    manufacturerKey: row.manufacturer_key,
    partType: row.part_type,
    partTypeKey: row.part_type_key,
    packageFamily: row.package_family,
    electricalClass: row.electrical_class,
    score: Number(row.score ?? MANUFACTURER_SCORE_SEED),
    confidenceLevel: row.confidence_level || 'low',
    attemptCount: Number(row.attempt_count ?? 0),
    missCount: Number(row.miss_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    activeCandidateCount: Number(row.active_candidate_count ?? 0),
    inStockCandidateCount: Number(row.in_stock_candidate_count ?? 0),
    exclusionStatus: row.exclusion_status || 'active',
    reasonForExclusion: row.reason_for_exclusion || '',
    firstSearchedAt: row.first_searched_at || '',
    lastSearchedAt: row.last_searched_at || '',
    lastSuccessfulSearchAt: row.last_successful_search_at || ''
  };
}

function saveManufacturerSearchAttempt(attempt) {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(
      `
      INSERT INTO manufacturer_search_attempts (
        manufacturer_name,
        manufacturer_key,
        part_type,
        part_type_key,
        package_family,
        electrical_class,
        source_part_number,
        source_technical_summary,
        search_query,
        search_source,
        candidate_part_numbers_json,
        candidate_count,
        active_candidate_count,
        in_stock_candidate_count,
        rejected_candidate_count,
        result_classification,
        reason,
        raw_json,
        searched_at
      )
      VALUES (
        @manufacturerName,
        @manufacturerKey,
        @partType,
        @partTypeKey,
        @packageFamily,
        @electricalClass,
        @sourcePartNumber,
        @sourceTechnicalSummary,
        @searchQuery,
        @searchSource,
        @candidatePartNumbersJson,
        @candidateCount,
        @activeCandidateCount,
        @inStockCandidateCount,
        @rejectedCandidateCount,
        @resultClassification,
        @reason,
        @rawJson,
        @searchedAt
      )
    `
    )
    .run({
      manufacturerName: attempt.manufacturerName || '',
      manufacturerKey: attempt.manufacturerKey || normalizeManufacturerKey(attempt.manufacturerName),
      partType: attempt.partType || '',
      partTypeKey: attempt.partTypeKey || normalizePartType(attempt.partType),
      packageFamily: attempt.packageFamily || '',
      electricalClass: attempt.electricalClass || '',
      sourcePartNumber: attempt.sourcePartNumber || '',
      sourceTechnicalSummary: attempt.sourceTechnicalSummary || '',
      searchQuery: attempt.searchQuery || '',
      searchSource: attempt.searchSource || '',
      candidatePartNumbersJson: JSON.stringify(attempt.candidatePartNumbers ?? []),
      candidateCount: Number(attempt.candidateCount ?? 0),
      activeCandidateCount: Number(attempt.activeCandidateCount ?? 0),
      inStockCandidateCount: Number(attempt.inStockCandidateCount ?? 0),
      rejectedCandidateCount: Number(attempt.rejectedCandidateCount ?? 0),
      resultClassification: attempt.resultClassification || 'error',
      reason: attempt.reason || '',
      rawJson: JSON.stringify(attempt.raw ?? {}),
      searchedAt: now
    });
}

function updateManufacturerCapabilityScoreFromAttempt(attempt) {
  const manufacturerKey = attempt.manufacturerKey || normalizeManufacturerKey(attempt.manufacturerName);
  const partTypeKey = attempt.partTypeKey || normalizePartType(attempt.partType);
  const packageFamily = attempt.packageFamily || '';
  const now = new Date().toISOString();
  const existing = getManufacturerCapabilityScore(manufacturerKey, partTypeKey, packageFamily);
  const completed = isCompletedSearchAttempt(attempt.resultClassification);
  const miss = isManufacturerSearchMiss(attempt.resultClassification);
  const success = attempt.resultClassification === 'success';
  const priorAttemptCount = Number(existing?.attemptCount ?? 0);
  const attemptCount = completed
    ? countDistinctManufacturerSearchSources(manufacturerKey, partTypeKey, packageFamily, ['success', 'miss', 'partial'])
    : priorAttemptCount;
  const missCount = completed
    ? countDistinctManufacturerSearchSources(manufacturerKey, partTypeKey, packageFamily, ['miss'])
    : Number(existing?.missCount ?? 0);
  const successCount = completed
    ? countDistinctManufacturerSearchSources(manufacturerKey, partTypeKey, packageFamily, ['success'])
    : Number(existing?.successCount ?? 0);
  const currentScore = Number(existing?.score ?? MANUFACTURER_SCORE_SEED);
  let score = currentScore;

  if (completed) {
    if (missCount >= 2) {
      score = 0;
    } else if (miss) {
      score = 25;
    } else if (attempt.resultClassification === 'partial') {
      score = Math.min(60, Math.max(45, currentScore));
    } else if (successCount >= 2) {
      score = Math.max(85, Math.min(100, currentScore + 15));
    } else if (success) {
      score = Math.max(70, currentScore);
    }
  }

  const exclusionStatus = score === 0 ? 'excluded' : 'active';
  const reasonForExclusion = exclusionStatus === 'excluded' ? attempt.reason || 'Two completed misses for this part type.' : '';

  getDatabase()
    .prepare(
      `
      INSERT INTO manufacturer_capability_scores (
        manufacturer_name,
        manufacturer_key,
        part_type,
        part_type_key,
        package_family,
        electrical_class,
        score,
        confidence_level,
        attempt_count,
        miss_count,
        success_count,
        active_candidate_count,
        in_stock_candidate_count,
        exclusion_status,
        reason_for_exclusion,
        first_searched_at,
        last_searched_at,
        last_successful_search_at
      )
      VALUES (
        @manufacturerName,
        @manufacturerKey,
        @partType,
        @partTypeKey,
        @packageFamily,
        @electricalClass,
        @score,
        @confidenceLevel,
        @attemptCount,
        @missCount,
        @successCount,
        @activeCandidateCount,
        @inStockCandidateCount,
        @exclusionStatus,
        @reasonForExclusion,
        @firstSearchedAt,
        @lastSearchedAt,
        @lastSuccessfulSearchAt
      )
      ON CONFLICT(manufacturer_key, part_type_key, package_family) DO UPDATE SET
        manufacturer_name = excluded.manufacturer_name,
        part_type = excluded.part_type,
        electrical_class = excluded.electrical_class,
        score = excluded.score,
        confidence_level = excluded.confidence_level,
        attempt_count = excluded.attempt_count,
        miss_count = excluded.miss_count,
        success_count = excluded.success_count,
        active_candidate_count = excluded.active_candidate_count,
        in_stock_candidate_count = excluded.in_stock_candidate_count,
        exclusion_status = excluded.exclusion_status,
        reason_for_exclusion = excluded.reason_for_exclusion,
        last_searched_at = excluded.last_searched_at,
        last_successful_search_at = excluded.last_successful_search_at
    `
    )
    .run({
      manufacturerName: attempt.manufacturerName || '',
      manufacturerKey,
      partType: attempt.partType || '',
      partTypeKey,
      packageFamily,
      electricalClass: attempt.electricalClass || '',
      score,
      confidenceLevel: calculateManufacturerConfidence({ attemptCount, hasConflictingEvidence: missCount > 0 && successCount > 0 }),
      attemptCount,
      missCount,
      successCount,
      activeCandidateCount: Number(existing?.activeCandidateCount ?? 0) + Number(attempt.activeCandidateCount ?? 0),
      inStockCandidateCount: Number(existing?.inStockCandidateCount ?? 0) + Number(attempt.inStockCandidateCount ?? 0),
      exclusionStatus,
      reasonForExclusion,
      firstSearchedAt: existing?.firstSearchedAt || now,
      lastSearchedAt: now,
      lastSuccessfulSearchAt: success ? now : existing?.lastSuccessfulSearchAt || ''
    });
}

function countDistinctManufacturerSearchSources(manufacturerKey, partTypeKey, packageFamily, classifications) {
  const placeholders = classifications.map(() => '?').join(', ');
  const row = getDatabase()
    .prepare(
      `
      SELECT COUNT(DISTINCT source_part_number) AS count
      FROM manufacturer_search_attempts
      WHERE manufacturer_key = ?
        AND part_type_key = ?
        AND package_family = ?
        AND result_classification IN (${placeholders})
    `
    )
    .get(manufacturerKey, partTypeKey, packageFamily, ...classifications);
  return Number(row?.count ?? 0);
}

function calculateManufacturerConfidence({ attemptCount, hasConflictingEvidence = false }) {
  if (hasConflictingEvidence) {
    return 'medium';
  }
  if (attemptCount >= 6) {
    return 'high';
  }
  if (attemptCount >= 2) {
    return 'medium';
  }
  return 'low';
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
  const tabularCandidates = [
    ...extractTabularPartCandidatesFromLines(lines),
    ...extractStackedTablePartCandidatesFromLines(lines)
  ];
  const tabularLineIndexes = new Set(tabularCandidates.map((candidate) => candidate.lineIndex).filter(Number.isInteger));
  const preferStructuredExtraction = tabularCandidates.length > 0;

  for (const candidate of tabularCandidates) {
    addCandidate(candidates, seen, candidate.rawCandidate, candidate.sourceLine, candidate.lineIndex);
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (tabularLineIndexes.has(lineIndex)) {
      continue;
    }

    const labeled = extractLabeledPartCandidates(line);
    for (const rawCandidate of labeled) {
      addCandidate(candidates, seen, rawCandidate, line, lineIndex);
    }

    if (preferStructuredExtraction) {
      continue;
    }

    const tokenMatches = line.match(/\b[A-Z0-9][A-Z0-9._/-]{2,}[A-Z0-9]\b/gi) ?? [];
    for (const token of tokenMatches) {
      addCandidate(candidates, seen, token, line, lineIndex);
    }
  }

  if (tabularCandidates.length > 0) {
    return candidates.slice(0, maxParts);
  }

  const fallbackMatches = String(clipText).match(/\b[A-Z0-9][A-Z0-9._/-]{3,}[A-Z0-9]\b/gi) ?? [];
  for (const token of fallbackMatches) {
    addCandidate(candidates, seen, token, '', null);
  }

  return candidates.slice(0, maxParts);
}

function extractTabularPartCandidatesFromLines(lines) {
  const parsedRows = lines.map((line, lineIndex) => ({
    line,
    lineIndex,
    columns: splitTableColumns(line)
  }));
  const tableCandidates = [];

  for (let index = 0; index < parsedRows.length; index += 1) {
    const headerRow = parsedRows[index];
    if (!looksLikeTableHeader(headerRow, parsedRows[index + 1])) {
      continue;
    }

    const tableRows = [];
    for (let rowIndex = index + 1; rowIndex < parsedRows.length; rowIndex += 1) {
      const row = parsedRows[rowIndex];
      if (!looksLikeCompatibleTableRow(headerRow, row)) {
        break;
      }
      tableRows.push(row);
    }

    if (!tableRows.length) {
      continue;
    }

    const partColumnIndex = chooseQualifiedPartColumnIndex(headerRow, tableRows);
    if (partColumnIndex < 0) {
      continue;
    }

    for (const row of tableRows) {
      const rawCandidate = row.columns[partColumnIndex] || '';
      if (rawCandidate) {
        tableCandidates.push({
          rawCandidate,
          sourceLine: row.line,
          lineIndex: row.lineIndex
        });
      }
    }

    index += tableRows.length;
  }

  if (tableCandidates.length > 0) {
    return tableCandidates;
  }

  for (const row of parsedRows) {
    const rawCandidate = extractStructuredRowPartCandidate(row.line);
    if (rawCandidate) {
      tableCandidates.push({
        rawCandidate,
        sourceLine: row.line,
        lineIndex: row.lineIndex
      });
    }
  }

  return tableCandidates;
}

function extractStackedTablePartCandidatesFromLines(lines) {
  const nonEmptyRows = lines
    .map((line, lineIndex) => ({ line: String(line || '').trim(), lineIndex }))
    .filter((row) => row.line);

  const headerIndex = findStackedTableHeaderIndex(nonEmptyRows);
  if (headerIndex < 0) {
    return [];
  }

  const candidates = [];
  for (let index = headerIndex + 4; index + 3 < nonEmptyRows.length; index += 4) {
    const rowCells = nonEmptyRows.slice(index, index + 4);
    if (!looksLikeStackedTableRow(rowCells)) {
      break;
    }

    const partCell = rowCells[2];
    const rawCandidate = normalizeCandidateQuery(partCell.line);
    if (!isQualifiedPartNumber(rawCandidate)) {
      continue;
    }

    candidates.push({
      rawCandidate,
      sourceLine: rowCells.map((cell) => cell.line).join(' '),
      lineIndex: partCell.lineIndex
    });
  }

  return candidates;
}

function findStackedTableHeaderIndex(rows) {
  for (let index = 0; index + 3 < rows.length; index += 1) {
    const labels = rows.slice(index, index + 4).map((row) => row.line.toLowerCase());
    if (
      /item/.test(labels[0]) &&
      /description/.test(labels[1]) &&
      /(impacted\s+.*(?:p\/n|pn)|skyworks\s+.*(?:p\/n|pn)|manufacturer\s+part|part\s+number|\bmpn\b)/.test(labels[2]) &&
      /(product|assembly|use)/.test(labels[3])
    ) {
      return index;
    }
  }
  return -1;
}

function looksLikeStackedTableRow(cells) {
  if (!Array.isArray(cells) || cells.length < 4) {
    return false;
  }

  const [itemCell, descriptionCell, partCell, productCell] = cells.map((cell) => normalizeCandidateQuery(cell.line));
  if (!/^(?:PPS-)?\d{6,}$/i.test(itemCell)) {
    return false;
  }
  if (!/[A-Z]/.test(descriptionCell) || !/\b(?:DIODE|VARACTOR|PIN|LIMITER|SOT|SOD|QFN|DFN|SC-|TO-)\b/i.test(descriptionCell)) {
    return false;
  }
  if (!isQualifiedPartNumber(partCell)) {
    return false;
  }
  if (/^(?:PPS-)?\d{6,}$/i.test(productCell)) {
    return false;
  }
  return true;
}

function splitTableColumns(line) {
  const text = String(line || '').trim();
  if (!text) {
    return [];
  }
  const rawColumns = text.includes('\t')
    ? text.split('\t')
    : text.split(/\s{2,}/);
  return rawColumns.map((value) => value.trim()).filter(Boolean);
}

function looksLikeTableHeader(headerRow, nextRow) {
  if (!headerRow || headerRow.columns.length < 3 || !nextRow || nextRow.columns.length < 3) {
    return false;
  }
  if (Math.abs(headerRow.columns.length - nextRow.columns.length) > 1) {
    return false;
  }

  const headerText = headerRow.columns.join(' ').toLowerCase();
  return /(part|mpn|mfr|manufacturer|description|item|product|qty|quantity)/.test(headerText);
}

function looksLikeCompatibleTableRow(headerRow, row) {
  if (!row || row.columns.length < 3) {
    return false;
  }
  if (Math.abs(headerRow.columns.length - row.columns.length) > 1) {
    return false;
  }
  const joined = row.columns.join(' ');
  return /[A-Z0-9]/i.test(joined);
}

function chooseQualifiedPartColumnIndex(headerRow, tableRows) {
  let bestIndex = -1;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let columnIndex = 0; columnIndex < headerRow.columns.length; columnIndex += 1) {
    const headerLabel = String(headerRow.columns[columnIndex] || '');
    const columnValues = tableRows.map((row) => row.columns[columnIndex] || '').filter(Boolean);
    if (!columnValues.length) {
      continue;
    }

    let score = scoreTableHeaderLabel(headerLabel);
    const likelyParts = columnValues.filter((value) => isLikelyPartNumber(value)).length;
    const qualifiedParts = columnValues.filter((value) => isQualifiedPartNumber(value)).length;
    const plainNumbers = columnValues.filter((value) => /^(?:PPS-)?\d{6,}$/i.test(normalizeCandidateQuery(value))).length;

    score += qualifiedParts * 8;
    score += likelyParts * 3;
    score -= plainNumbers * 5;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = columnIndex;
    }
  }

  return bestScore >= 6 ? bestIndex : -1;
}

function extractStructuredRowPartCandidate(line) {
  const text = String(line || '').trim();
  if (!/^(?:PPS-)?\d{6,}\b/i.test(text)) {
    return '';
  }

  const tokenMatches = text.match(/\b[A-Z0-9][A-Z0-9._/-]{2,}[A-Z0-9]\b/gi) ?? [];
  const scored = tokenMatches
    .map((token) => normalizeCandidateQuery(token))
    .filter((token) => isLikelyPartNumber(token))
    .map((token) => ({
      token,
      score: scoreStructuredRowToken(token)
    }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.score >= 8 ? scored[0].token : '';
}

function scoreStructuredRowToken(token) {
  let score = 0;

  if (isQualifiedPartNumber(token)) {
    score += 6;
  }
  if (token.includes('-')) {
    score += 6;
  }
  if (/[A-Z]/.test(token) && /[0-9]/.test(token)) {
    score += 4;
  }
  if (/(?:LF|TR|T&R|E3|BT|FT|DT)$/i.test(token)) {
    score += 3;
  }
  if (/^(?:PPS-)?\d{6,}$/i.test(token)) {
    score -= 10;
  }
  if (/^(?:QTY|PER|ITEM|DESCRIPTION|PRODUCTS?|SOT\d+|SOD\d+|SC\d+|TO\d+)$/i.test(token)) {
    score -= 8;
  }
  if (/^[A-Z]{2,}\d{3,}$/i.test(token) && !token.includes('-')) {
    score -= 4;
  }

  return score;
}

function scoreTableHeaderLabel(label) {
  const text = String(label || '').toLowerCase();
  let score = 0;

  if (/(manufacturer\s+part|mfr\s+part|part\s+number|impacted\s+.*p\/n|impacted\s+.*pn|\bmpn\b|\bp\/n\b|\bpn\b)/.test(text)) {
    score += 20;
  }
  if (/(qualified|approved|source)\s+(part|p\/n|pn|mpn)/.test(text)) {
    score += 10;
  }
  if (/(description|product|products|item|qty|quantity|note|usage|customer)/.test(text)) {
    score -= 18;
  }

  return score;
}

function isQualifiedPartNumber(value) {
  const token = normalizeCandidateQuery(value);
  return isLikelyPartNumber(token) && /[A-Z]/.test(token) && /[0-9]/.test(token);
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
  const status = normalizeLifecycleStatus(candidateStatus);
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

  if (isExcludedLifecycleStatus(candidateStatus)) {
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

function determineCandidateCategory({
  score,
  candidateStatusText,
  candidateStock,
  packageCheck,
  supplierPackageCheck,
  hasCriticalTechnicalGaps = false
}) {
  const stock = Number(candidateStock);
  const hasCriticalLifecycleRisk = isExcludedLifecycleStatus(candidateStatusText);
  const hasZeroStock = Number.isFinite(stock) && stock <= 0;
  const hasDropInPackageRisk = Boolean(packageCheck?.criticalMismatch || supplierPackageCheck?.criticalMismatch);

  if (hasCriticalLifecycleRisk || hasZeroStock) {
    return 'Poor match';
  }

  if (hasCriticalTechnicalGaps && score >= 58) {
    return 'Possible with review';
  }

  if (score >= 78 && !hasDropInPackageRisk) {
    return 'Recommended';
  }

  if (score >= 58) {
    return 'Possible with review';
  }

  return 'Poor match';
}

function hasCriticalTechnicalReviewGaps(reviewNotes) {
  const text = (Array.isArray(reviewNotes) ? reviewNotes : []).join(' ').toLowerCase();
  return (
    /reverse voltage .*incomplete/.test(text) ||
    /reverse voltage .*could not be normalized/.test(text) ||
    /capacitance .*incomplete/.test(text) ||
    /capacitance .*could not be normalized/.test(text) ||
    /diode type .*incomplete/.test(text) ||
    /diode type .*could not be normalized/.test(text)
  );
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
  const parsed = parsePositivePrice(value);
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
      unitPrice: parsePositivePrice(firstValue(row, ['unitPrice', 'UnitPrice', 'price', 'Price']))
    }))
    .filter((entry) => Number.isFinite(entry.unitPrice) && entry.unitPrice > 0);

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

function parsePositivePrice(value) {
  if (value === null || value === undefined) {
    return NaN;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return NaN;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN;
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

function normalizeManufacturerKey(value) {
  return normalizeQueryKey(value);
}

function isManufacturerCapabilityFresh(updatedAt) {
  if (!updatedAt) {
    return false;
  }
  const time = new Date(updatedAt).getTime();
  if (!Number.isFinite(time)) {
    return false;
  }
  return Date.now() - time <= MANUFACTURER_CAPABILITY_TTL_MS;
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

function readIntegerEnv(key, fallback) {
  const value = Number.parseInt(readEnv(key, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
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

    CREATE TABLE IF NOT EXISTS manufacturer_capability_scores (
      manufacturer_key TEXT NOT NULL,
      part_type_key TEXT NOT NULL,
      package_family TEXT NOT NULL DEFAULT '',
      manufacturer_name TEXT NOT NULL,
      part_type TEXT NOT NULL,
      electrical_class TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL DEFAULT 50,
      confidence_level TEXT NOT NULL DEFAULT 'low',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      miss_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      active_candidate_count INTEGER NOT NULL DEFAULT 0,
      in_stock_candidate_count INTEGER NOT NULL DEFAULT 0,
      exclusion_status TEXT NOT NULL DEFAULT 'active',
      reason_for_exclusion TEXT NOT NULL DEFAULT '',
      first_searched_at TEXT NOT NULL,
      last_searched_at TEXT NOT NULL,
      last_successful_search_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (manufacturer_key, part_type_key, package_family)
    );

    CREATE TABLE IF NOT EXISTS manufacturer_search_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manufacturer_name TEXT NOT NULL,
      manufacturer_key TEXT NOT NULL,
      part_type TEXT NOT NULL,
      part_type_key TEXT NOT NULL,
      package_family TEXT NOT NULL DEFAULT '',
      electrical_class TEXT NOT NULL DEFAULT '',
      source_part_number TEXT NOT NULL,
      source_technical_summary TEXT NOT NULL DEFAULT '',
      search_query TEXT NOT NULL,
      search_source TEXT NOT NULL,
      candidate_part_numbers_json TEXT NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      active_candidate_count INTEGER NOT NULL DEFAULT 0,
      in_stock_candidate_count INTEGER NOT NULL DEFAULT 0,
      rejected_candidate_count INTEGER NOT NULL DEFAULT 0,
      result_classification TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL,
      searched_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_part_records_updated_at ON part_records(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_clip_analyses_updated_at ON clip_analyses(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_manufacturer_scores_part_type ON manufacturer_capability_scores(part_type_key, score DESC);
    CREATE INDEX IF NOT EXISTS idx_manufacturer_attempts_part_type ON manufacturer_search_attempts(part_type_key, searched_at DESC);
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
