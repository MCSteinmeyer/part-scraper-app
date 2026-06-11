import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const projectDir = new URL('../', import.meta.url);
const widgetHtml = readFileSync(new URL('../src/widget.html', import.meta.url), 'utf8');
const port = Number(process.env.PORT || 3140);
const baseUrl = `http://127.0.0.1:${port}`;

const sampleMatch = widgetHtml.match(/const REFERENCE_SAMPLE_CLIP = \[(?<body>[\s\S]*?)\]\.join\('\\n'\);/);
if (!sampleMatch?.groups?.body) {
  throw new Error('Could not find REFERENCE_SAMPLE_CLIP in src/widget.html');
}

const lines = [];
for (const match of sampleMatch.groups.body.matchAll(/'((?:\\'|[^'])*)'/g)) {
  lines.push(match[1].replace(/\\'/g, "'").replace(/\\t/g, '\t'));
}
const clipText = lines.join('\n');

const server = spawn(process.execPath, ['src/server.mjs', 'http'], {
  cwd: projectDir,
  env: {
    ...process.env,
    PORT: String(port)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

const output = [];
const errors = [];
server.stdout.on('data', (chunk) => output.push(String(chunk)));
server.stderr.on('data', (chunk) => errors.push(String(chunk)));

try {
  await waitForHealth();
  const client = await createClient();
  const result = await client.callTool('parts.analyze_clip', {
    clipText,
    maxParts: 10,
    maxRecommendations: 3
  });
  const structured = result?.structuredContent ?? result?.result?.structuredContent ?? result;
  const rankParts = parseRankParts(structured);
  const rankings = [];
  for (const partNumber of rankParts) {
    const rankingResult = await client.callTool('parts.rank_substitutes', {
      sourcePartNumber: partNumber,
      maxCandidates: Number(process.env.MAX_RANK_CANDIDATES || 3)
    });
    const ranking = rankingResult?.structuredContent ?? rankingResult?.result?.structuredContent ?? rankingResult;
    const textSummary = (rankingResult?.content ?? [])
      .filter((item) => item?.type === 'text')
      .map((item) => item.text)
      .join('\n');
    rankings.push({
      sourcePartNumber: partNumber,
      candidateCount: ranking?.candidateCount ?? 0,
      reason: ranking?.reason ?? '',
      textSummary,
      candidates: (ranking?.candidates ?? []).map((candidate) => ({
        candidatePartNumber: candidate.candidatePartNumber,
        manufacturerName: candidate.manufacturerName,
        category: candidate.category,
        score: candidate.score,
        status: candidate.productStatus,
        stock: candidate.stock,
        reasons: candidate.reasons,
        reviewNotes: candidate.reviewNotes
      }))
    });
  }
  console.log(JSON.stringify({
    ok: true,
    extractedParts: structured?.extractedParts ?? [],
    partCount: Array.isArray(structured?.parts) ? structured.parts.length : 0,
    parts: (structured?.parts ?? []).map((part) => ({
      query: part.query,
      matchedManufacturerPartNumber: part.matchedManufacturerPartNumber,
      productStatus: part.productStatus,
      stock: part.stock,
      unitPrice: part.unitPrice,
      recommendationCount: Array.isArray(part.recommendations) ? part.recommendations.length : 0
    })),
    cacheSummary: structured?.cacheSummary ?? null,
    rankings
  }, null, 2));
} finally {
  server.kill('SIGTERM');
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Server did not become healthy. stdout=${output.join('')} stderr=${errors.join('')}`);
}

async function createClient() {
  let id = 1;
  await rpc(id++, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {
      name: 'part-scraper-reference-test',
      version: '0.1.0'
    }
  });

  try {
    await rpc(id++, 'notifications/initialized', {});
  } catch {
    // Older MCP transports may not require the initialized notification.
  }

  return {
    callTool: async (name, args) => {
      const response = await rpc(id++, 'tools/call', {
        name,
        arguments: args
      });
      return response.result;
    }
  };
}

function parseRankParts(analysis) {
  if (process.env.RUN_RANK_SUBSTITUTES !== 'true') {
    return [];
  }
  if (process.env.RANK_PARTS) {
    return process.env.RANK_PARTS.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return (analysis?.extractedParts ?? []).map((part) => part.query).filter(Boolean);
}

async function rpc(id, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    })
  });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || `MCP ${method} failed`);
  }
  return data;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
