import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getAuthorizationToken } from '../dist/index.js';

/** Build a response with its final URL populated, as Node fetch does. */
function assetResponse(url, content, contentType = 'text/javascript') {
  const result = new Response(content, { headers: { 'content-type': contentType } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** Provide a minimal HTML → Entry → hashed chunk discovery chain. */
function makeFixtures(chunkContent, secondChunkContent = 'export const unrelated = true;') {
  const entry = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BadkwjBO.js';
  const runtime = 'https://abs.twimg.com/x-web/x-web/assets/B644W4is.js';
  const first = 'https://abs.twimg.com/x-web/x-web/assets/DFhr1Vbc.js';
  const second = 'https://abs.twimg.com/x-web/x-web/assets/DY5yQU7B.js';
  const fixtures = new Map([
    ['https://x.com/', [`<script>const entryHref = "${entry}";</script>`, 'text/html']],
    [entry, [[
      'const __vite__mapDeps = i => ["assets/ignore-preload.js"];',
      'import { a } from "./assets/B644W4is.js";',
      'import { b } from "./assets/DFhr1Vbc.js";',
      'import { c } from "./assets/DY5yQU7B.js";',
    ].join('\n'), 'text/javascript']],
    [runtime, ['export const a = true;', 'text/javascript']],
    [first, [chunkContent, 'text/javascript']],
    [second, [secondChunkContent, 'text/javascript']],
  ]);
  const requests = [];
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'must-login-auth-unit-'));
  return {
    requests,
    cacheDirectory,
    cleanup: () => rm(cacheDirectory, { recursive: true, force: true }),
    fetch: async url => {
      requests.push(String(url));
      const fixture = fixtures.get(String(url));
      assert.ok(fixture, `Unexpected URL ${url}`);
      return assetResponse(String(url), ...fixture);
    },
  };
}

/** Capture structured lifecycle events without printing extracted secrets. */
function collectLogger() {
  const events = [];
  return {
    events,
    logger: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level,
      (message, details) => events.push({ level, message, details }),
    ])),
  };
}

test('ESM extracts a fixed Bearer from a direct static Entry import without executing JS', async t => {
  const token = 'Bearer AAAAAAAAAA_SECRET_SAMPLE%3D123';
  const chain = makeFixtures([
    'globalThis.__mustLoginAuthorizationProbeExecuted = true;',
    'function ar(e, t = {}) {',
    ' const headers = new Map;',
    ` headers.set(\`Authorization\`, \`${token}\`);`,
    ' return headers;',
    '}',
  ].join('\n'));
  t.after(chain.cleanup);
  const { events, logger } = collectLogger();
  try {
    const authorization = await getAuthorizationToken({ fetch: chain.fetch, logger, cacheDirectory: chain.cacheDirectory });
    assert.equal(authorization, token);
    assert.equal(globalThis.__mustLoginAuthorizationProbeExecuted, undefined);
    assert.equal(chain.requests.length, 5);
    assert.equal(events.some(event => event.level === 'debug'), false);
    assert.equal(events.at(-1).message, 'Authorization Token 提取成功');
    assert.equal(JSON.stringify(events).includes(token), false);
  } finally {
    delete globalThis.__mustLoginAuthorizationProbeExecuted;
  }
});

test('verbose mode logs resource metadata but never logs the Authorization value', async t => {
  const chain = makeFixtures('const m = new Map(); m.set("Authorization", "Bearer SAMPLE_987%3D");');
  t.after(chain.cleanup);
  const { events, logger } = collectLogger();
  const token = await getAuthorizationToken({ fetch: chain.fetch, logger, verbose: true, cacheDirectory: chain.cacheDirectory });
  assert.equal(token, 'Bearer SAMPLE_987%3D');
  assert.equal(events.some(event => event.level === 'debug'), true);
  assert.equal(JSON.stringify(events).includes('Bearer SAMPLE_987%3D'), false);
});

test('ambiguous hardcoded Authorization assignments are rejected', async t => {
  const chain = makeFixtures(
    'const x = new Map(); x.set("Authorization", "Bearer FIRST_123");',
    'const y = new Map(); y.set("Authorization", "Bearer SECOND_456");',
  );
  t.after(chain.cleanup);
  const { logger } = collectLogger();
  await assert.rejects(
    getAuthorizationToken({ fetch: chain.fetch, logger, cacheDirectory: chain.cacheDirectory }),
    /无法唯一确定 Authorization Token，匹配数量：2/,
  );
});

test('missing Authorization assignment is rejected; Vite preload strings are not fetched', async t => {
  const chain = makeFixtures('export const b = "Bearer is absent from Authorization Map";');
  t.after(chain.cleanup);
  const { logger } = collectLogger();
  await assert.rejects(
    getAuthorizationToken({ fetch: chain.fetch, logger, cacheDirectory: chain.cacheDirectory }),
    /无法唯一确定 Authorization Token，匹配数量：0/,
  );
  assert.equal(chain.requests.some(url => url.includes('ignore-preload')), false);
});
