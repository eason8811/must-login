import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateSign, generateSignForUrl, shouldGenerateSign } from '../dist/index.js';

/** Construct a fetch-compatible response with a stable, validated URL. */
function response(url, text, contentType) {
  const result = new Response(text, { headers: { 'content-type': contentType } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** Build a minimal offline HTML fixture with four signing SVGs. */
function fixtureHtml(entryUrl) {
  const svg = Array.from({ length: 4 }, (_, index) =>
    `<svg id="loading-x-anim-${index}"><g><rect width="1" height="1"/><path d="M0 0 L1 1"/></g></svg>`,
  ).join('');
  return `<html><head><meta name="twitter-site-verification" content="YWJjZGVmZ2g="/><script src="${entryUrl}"></script></head><body>${svg}</body></html>`;
}

test('ESM import fetches the paired SDK and produces a sign with quiet logs', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'must-login-test-'));
  const entryUrl = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-a1.js';
  const decoyUrl = 'https://abs.twimg.com/x-web/x-web/assets/BMpThmqI.js';
  const startupUrl = 'https://abs.twimg.com/x-web/x-web/assets/dSSXoMgG.js';
  const sdkUrl = 'https://abs.twimg.com/x-web/x-web/assets/CYgkI3Mb.js';
  const runtimeUrl = 'https://abs.twimg.com/x-web/x-web/assets/B644W4is.js';
  const data = new Map([
    ['https://x.com/', [fixtureHtml(entryUrl), 'text/html']],
    [entryUrl, [
      'const __vite__mapDeps = i => ["assets/ignored.js"];\n' +
      'import { value as irrelevant } from "./assets/BMpThmqI.js";\n' +
      'import { value as dispatcher } from "./assets/dSSXoMgG.js";',
      'text/javascript',
    ]],
    [decoyUrl, ['export const value = "unrelated module";', 'text/javascript']],
    [startupUrl, [
      'function Zm() { return import(`./CYgkI3Mb.js`).then(e => e.default()); }\n' +
      'function Qm(e) { return e === `jf.x.com` || e.endsWith(`.jf.x.com`) ? `PATCH` : `GET`; }',
      'text/javascript',
    ]],
    [sdkUrl, [
      'import { capturedWindow } from "./B644W4is.js";\n' +
      'export default async function () {' +
      ' return (input, method) => capturedWindow === globalThis.window ? `${input}|${method}` : "STALE_DOM";' +
      '}',
      'text/javascript',
    ]],
    [runtimeUrl, ['export const capturedWindow = globalThis.window;', 'text/javascript']],
  ]);
  const logs = [];
  const logger = {
    info(message, details) { logs.push(['info', message, details]); },
    warn(message, details) { logs.push(['warn', message, details]); },
    error(message, details) { logs.push(['error', message, details]); },
    debug(message, details) { logs.push(['debug', message, details]); },
  };
  const fetchMock = async (url) => {
    const entry = data.get(String(url));
    assert.ok(entry, `unexpected URL: ${url}`);
    return response(String(url), ...entry);
  };
  try {
    const result = await generateSign('jf', 'patch', {
      allowRemoteSdkExecution: true,
      verbose: false,
      cacheDirectory,
      logger,
      fetch: fetchMock,
    });
    assert.equal(result, 'jf|PATCH');
    assert.equal(logs.some(([level]) => level === 'debug'), false);
    assert.equal(logs.some(([, message]) => message === '签名生成成功'), true);
    assert.equal(logs.some(([, , details]) => JSON.stringify(details)?.includes('jf|PATCH')), false);
    const another = await generateSign('/i/api/example', 'get', {
      allowRemoteSdkExecution: true,
      verbose: true,
      cacheDirectory,
      logger,
      fetch: fetchMock,
    });
    assert.equal(another, '/i/api/example|GET');
    assert.equal(logs.some(([level]) => level === 'debug'), true);
    assert.equal(shouldGenerateSign('https://jf.x.com/some/path'), true);
    assert.equal(shouldGenerateSign('https://example.com/i/api'), false);
    assert.equal(shouldGenerateSign('http://api.x.com/i/api'), false);
    const jfSignature = await generateSignForUrl('https://jf.x.com/anything', 'GET', {
      allowRemoteSdkExecution: true,
      cacheDirectory,
      logger,
      fetch: fetchMock,
    });
    assert.equal(jfSignature, 'jf|PATCH');
    assert.equal(await generateSignForUrl('https://example.com/', 'GET'), undefined);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test('hashed Startup discovery refuses ambiguous signature candidates', async () => {
  const entryUrl = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-a1.js';
  const firstUrl = 'https://abs.twimg.com/x-web/x-web/assets/AAA11111.js';
  const secondUrl = 'https://abs.twimg.com/x-web/x-web/assets/BBB22222.js';
  const marker = 'const host = `jf.x.com`, child = `.jf.x.com`, method = `PATCH`;';
  const fixtures = new Map([
    ['https://x.com/', [fixtureHtml(entryUrl), 'text/html']],
    [entryUrl, ['import "./assets/AAA11111.js"; import "./assets/BBB22222.js";', 'text/javascript']],
    [firstUrl, [marker, 'text/javascript']],
    [secondUrl, [marker, 'text/javascript']],
  ]);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  await assert.rejects(
    generateSign('jf', 'PATCH', {
      allowRemoteSdkExecution: true,
      logger,
      fetch: async url => {
        const value = fixtures.get(String(url));
        assert.ok(value);
        return response(String(url), ...value);
      },
    }),
    /无法唯一确定签名调用模块，候选数量：2/,
  );
});
