import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const previewUrl = process.env.PREVIEW_URL || 'http://127.0.0.1:3111/preview';
const autoStartServer = process.env.START_PREVIEW_SERVER === 'true';
const serverPort = Number(process.env.PORT || 3111);

let browserApi;
try {
  browserApi = await import('playwright');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Playwright is not installed for this project.');
  console.error('Run `npm install --save-dev playwright` in part-scraper-app, then run this script again.');
  console.error(`Original error: ${message}`);
  process.exit(1);
}

let serverProcess = null;
if (autoStartServer) {
  serverProcess = spawn(process.execPath, ['src/server.mjs', 'http'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      PORT: String(serverPort),
      MCP_ALLOW_DEMO: process.env.MCP_ALLOW_DEMO || 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  serverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  await waitForUrl(`${new URL(previewUrl).origin}/healthz`, 10_000);
}

const browser = await browserApi.chromium.launch({
  headless: false
});

const page = await browser.newPage({
  viewport: {
    width: 1440,
    height: 1100
  }
});

await page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#clipText');

console.log(`Preview page opened at ${previewUrl}`);
console.log('Paste the email clip into the text box, click "Analyze clip", and wait for the results to render.');
console.log('When the page looks ready, come back here and press Enter.');

const rl = createInterface({ input, output });
await rl.question('Press Enter after the analysis finishes in the browser window. ');
rl.close();

await page.waitForTimeout(500);

const summary = await page.evaluate(() => {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
  const cards = [...document.querySelectorAll('.part-card')].map((card) => {
    const title = card.querySelector('.part-title')?.textContent?.trim() || '';
    const pills = [...card.querySelectorAll('.pill')].map((pill) => pill.textContent?.trim() || '').filter(Boolean);
    const sectionTitles = [...card.querySelectorAll('.section h3')].map((node) => node.textContent?.trim() || '').filter(Boolean);
    const replacements = [...card.querySelectorAll('.sub-item')].map((item) => ({
      name: item.querySelector('.sub-name')?.textContent?.trim() || '',
      lines: [...item.querySelectorAll('.sub-meta')].map((node) => node.textContent?.trim() || '').filter(Boolean)
    }));
    return {
      title,
      pills,
      sectionTitles,
      replacements
    };
  });

  return {
    statusMain: text('#statusMain'),
    statusSub: text('#statusSub'),
    metricParts: text('#metricParts'),
    metricCache: text('#metricCache'),
    metricDb: text('#metricDb'),
    analysisNote: text('#analysisNote'),
    clipLength: Number(document.querySelector('#clipText')?.value?.length || 0),
    resultsEmptyState: text('#results .empty-state'),
    partCardCount: cards.length,
    cards
  };
});

console.log(JSON.stringify(summary, null, 2));

console.log('Press Enter to close the Playwright browser window.');
const closeRl = createInterface({ input, output });
await closeRl.question('');
closeRl.close();

await browser.close();
if (serverProcess) {
  serverProcess.kill('SIGTERM');
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
