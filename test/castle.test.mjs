import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateCastleToken, generateSign } from '../dist/index.js';

/** Create a fetch-compatible response with its real source URL. */
function response(url, source, type = 'text/javascript') {
  const result = new Response(source, { headers: { 'content-type': type } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** Create the current HTML / Entry / Startup / key / SDK discovery fixtures. */
function castleFixtures({ duplicateKey = false, duplicateStartup = false } = {}) {
  const entryUrl = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BadkwjBO.js';
  const startupUrl = 'https://abs.twimg.com/x-web/x-web/assets/dSSXoMgG.js';
  const configUrl = 'https://abs.twimg.com/x-web/x-web/assets/BMpThmqI.js';
  const irrelevantUrl = 'https://abs.twimg.com/x-web/x-web/assets/irrelEvA.js';
  const castleUrl = 'https://abs.twimg.com/x-web/x-web/assets/2R3RE05z.js';
  const secondStartup = 'https://abs.twimg.com/x-web/x-web/assets/secoNd01.js';
  const key = 'pk_AvRa79bHyJSYSQHnRpcVtzyxetSvFerx';
  const html = `<html><head><script>var entryHref = "${entryUrl}";</script></head><body></body></html>`;
  const startup = [
    'import {cfg as c} from "./BMpThmqI.js";',
    'import {irrelevant as i} from "./irrelEvA.js";',
    'function DN(t) {',
    ' if (!t.isTrue(`responsive_web_castle_sdk_enabled`)) return Promise.resolve();',
    ' let n = t.getStringValue(`responsive_web_castle_public_key`);',
    ' return n ? (SN ??= Promise.resolve().then(() => A(() =>',
    '   import(`./2R3RE05z.js`).then(t => e(t.default, 1)), __vite__mapDeps([886])))',
    '   .then(e => e.configure({pk:n})), SN) : Promise.resolve(void 0);',
    '}',
    'function Qm(e){return e===`jf.x.com`||e.endsWith(`.jf.x.com`)?`PATCH`:`GET`}',
  ].join('\n');
  const fixture = new Map([
    ['https://x.com/', [html, 'text/html']],
    [entryUrl, [
      'import "./assets/BMpThmqI.js"; import "./assets/dSSXoMgG.js";' +
        (duplicateStartup ? ' import "./assets/secoNd01.js";' : ''),
    ]],
    [startupUrl, [startup]],
    [configUrl, [`export const cfg = {responsive_web_castle_sdk_enabled: !0, responsive_web_castle_public_key: \`${key}\`};`]],
    [irrelevantUrl, [duplicateKey
      ? 'export const irrelevant = {responsive_web_castle_public_key: `pk_DIFFERENTKEY1234567`};'
      : 'export const irrelevant = true;']],
    [castleUrl, [
      'export default {' +
      ' configure({pk}) { return {createRequestToken: async () => `castle-token:${pk}`}; },' +
      ' createRequestToken() { return "unconfigured"; }' +
      '};',
    ]],
  ]);
  if (duplicateStartup) fixture.set(secondStartup, [startup]);
  return { fixture, key };
}

/** Create an offline fetcher that rejects unexpected downloads. */
function fetchFor(fixture) {
  return async url => {
    const key = String(url);
    const asset = fixture.get(key);
    assert.ok(asset, `Unexpected request: ${key}`);
    return response(key, ...asset);
  };
}

test('Castle ESM discovers SDK and version-matched pk, configures and creates token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'must-login-castle-'));
  const { fixture, key } = castleFixtures();
  const events = [];
  const logger = {
    info(message, details) { events.push(['info', message, details]); },
    warn(message, details) { events.push(['warn', message, details]); },
    error(message, details) { events.push(['error', message, details]); },
    debug(message, details) { events.push(['debug', message, details]); },
  };
  try {
    const token = await generateCastleToken({
      allowRemoteSdkExecution: true,
      fetch: fetchFor(fixture),
      logger,
      cacheDirectory: directory,
    });
    assert.equal(token, `castle-token:${key}`);
    assert.equal(events.some(([level]) => level === 'debug'), false);
    assert.equal(events.some(([, name]) => name === 'Castle Token 生成成功'), true);
    assert.equal(JSON.stringify(events).includes(key), false, 'Never log the public key');
    assert.equal(JSON.stringify(events).includes(token), false, 'Never log the token');

    const second = await generateCastleToken({
      allowRemoteSdkExecution: true,
      verbose: true,
      fetch: fetchFor(fixture),
      logger,
      cacheDirectory: directory,
    });
    assert.equal(second, token);
    assert.equal(events.some(([level]) => level === 'debug'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Castle remote code execution requires an explicit opt-in', async () => {
  await assert.rejects(generateCastleToken(), /allowRemoteSdkExecution/);
});

test('Castle rejects ambiguous Startup and conflicting pk candidates', async () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const startup = castleFixtures({ duplicateStartup: true });
  await assert.rejects(generateCastleToken({
    allowRemoteSdkExecution: true,
    fetch: fetchFor(startup.fixture),
    logger,
  }), /无法唯一匹配 Castle Startup：2/);

  const keys = castleFixtures({ duplicateKey: true });
  await assert.rejects(generateCastleToken({
    allowRemoteSdkExecution: true,
    fetch: fetchFor(keys.fixture),
    logger,
  }), /无法唯一匹配 Castle 公钥：2/);
});

test('Castle and Sign share a lock over the global Happy DOM environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'must-login-castle-lock-'));
  const { fixture, key } = castleFixtures();
  const signUrl = 'https://abs.twimg.com/x-web/x-web/assets/CYgkI3Mb.js';
  const startupUrl = 'https://abs.twimg.com/x-web/x-web/assets/dSSXoMgG.js';
  const originalStartup = fixture.get(startupUrl)[0];
  fixture.set(startupUrl, [originalStartup + '\nfunction Zm(){return import(`./CYgkI3Mb.js`).then(e=>e.default())}']);
  fixture.set(signUrl, ['export default () => (input, method) => `${input}:${method}`;']);
  const html = fixture.get('https://x.com/')[0];
  const svg = Array.from({ length: 4 }, (_, index) =>
    `<svg id="loading-x-anim-${index}"><g><rect/><path d="M0 0"/></g></svg>`,
  ).join('');
  fixture.set('https://x.com/', [html.replace('</head>', '<meta name="twitter-site-verification" content="YWJjZGVmZ2g="/></head>').replace('</body>', `${svg}</body>`), 'text/html']);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    const common = { allowRemoteSdkExecution: true, fetch: fetchFor(fixture), cacheDirectory: directory, logger };
    const [castle, sign] = await Promise.all([
      generateCastleToken(common),
      generateSign('jf', 'PATCH', common),
    ]);
    assert.equal(castle, `castle-token:${key}`);
    assert.equal(sign, 'jf:PATCH');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
