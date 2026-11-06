import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateCastleToken, generateSign, getAuthorizationToken } from '../dist/index.js';

/** Create a fetch-compatible response with its real source URL. */
function response(url, source, type = 'text/javascript') {
  const result = new Response(source, { headers: { 'content-type': type } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** Create the current HTML / Entry / Startup / key / SDK discovery fixtures. */
function castleFixtures({ duplicateKey = false, duplicateStartup = false, withRuntimeDependency = false } = {}) {
  const entryUrl = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BadkwjBO.js';
  const startupUrl = 'https://abs.twimg.com/x-web/x-web/assets/dSSXoMgG.js';
  const configUrl = 'https://abs.twimg.com/x-web/x-web/assets/BMpThmqI.js';
  const irrelevantUrl = 'https://abs.twimg.com/x-web/x-web/assets/irrelEvA.js';
  const castleUrl = 'https://abs.twimg.com/x-web/x-web/assets/2R3RE05z.js';
  const runtimeUrl = 'https://abs.twimg.com/x-web/x-web/assets/cnfsMYm8.js';
  const nestedRuntimeUrl = 'https://abs.twimg.com/x-web/x-web/assets/childAb12.js';
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
      (withRuntimeDependency ? 'import { capturedWindow } from "./cnfsMYm8.js";\n' : '') +
      'export default {' +
      ' configure({pk}) { return {createRequestToken: async () => `castle-token:${pk}`}; },' +
      ' createRequestToken() { return "unconfigured"; }' +
      '};',
    ]],
  ]);
  if (withRuntimeDependency) {
    fixture.set(runtimeUrl, ['export { capturedWindow } from "./childAb12.js";']);
    fixture.set(nestedRuntimeUrl, ['export const capturedWindow = globalThis.window;']);
    fixture.set(castleUrl, [
      'import { capturedWindow } from "./cnfsMYm8.js";\n' +
      'export default {' +
      ' configure({pk}) {return {' +
      '   createRequestToken: () => capturedWindow === globalThis.window ? `castle-token:${pk}` : "STALE_DOM"' +
      ' };},' +
      ' createRequestToken() {return "unconfigured";}' +
      '};',
    ]);
  }
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

test('Castle downloads a nested ESM runtime graph and rebinds dependencies to every fresh DOM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'must-login-castle-deps-'));
  const { fixture, key } = castleFixtures({ withRuntimeDependency: true });
  const debugEvents = [];
  const logger = {
    info() {}, warn() {}, error() {},
    debug(message, details) { debugEvents.push([message, details]); },
  };
  try {
    const options = {
      allowRemoteSdkExecution: true,
      cacheDirectory: directory,
      fetch: fetchFor(fixture),
      verbose: true,
      logger,
    };
    const first = await generateCastleToken(options);
    const second = await generateCastleToken(options);
    assert.equal(first, `castle-token:${key}`);
    assert.equal(second, first, 'Dependencies must capture the current DOM on each run');
    const bundles = debugEvents
      .filter(([event]) => event === 'Castle SDK 依赖图下载完成')
      .map(([, details]) => details);
    assert.equal(bundles.length, 2);
    assert.deepEqual(bundles.map(info => info.moduleCount), [3, 3]);
    assert.notEqual(bundles[0].bundleDirectory, bundles[1].bundleDirectory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Castle rejects an SDK dependency that escapes the restricted CDN path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'must-login-castle-unsafe-'));
  const { fixture } = castleFixtures();
  const sdkUrl = 'https://abs.twimg.com/x-web/x-web/assets/2R3RE05z.js';
  fixture.set(sdkUrl, ['import { value } from "../unexpected.js"; export default {configure() {}, createRequestToken() {}};']);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    await assert.rejects(generateCastleToken({
      allowRemoteSdkExecution: true,
      cacheDirectory: directory,
      fetch: fetchFor(fixture),
      logger,
    }), /不支持的模块引用/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Castle rejects ambiguous Startup and conflicting pk candidates', async () => {
  const firstDirectory = await mkdtemp(join(tmpdir(), 'must-login-castle-ambiguous-startup-'));
  const secondDirectory = await mkdtemp(join(tmpdir(), 'must-login-castle-ambiguous-pk-'));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    const startup = castleFixtures({ duplicateStartup: true });
    await assert.rejects(generateCastleToken({
      allowRemoteSdkExecution: true,
      cacheDirectory: firstDirectory,
      fetch: fetchFor(startup.fixture),
      logger,
    }), /无法唯一匹配 Castle Startup：2/);

    const keys = castleFixtures({ duplicateKey: true });
    await assert.rejects(generateCastleToken({
      allowRemoteSdkExecution: true,
      cacheDirectory: secondDirectory,
      fetch: fetchFor(keys.fixture),
      logger,
    }), /无法唯一匹配 Castle 公钥：2/);
  } finally {
    await Promise.all([firstDirectory, secondDirectory].map(directory => rm(directory, { recursive: true, force: true })));
  }
});

test('Castle and Sign share a lock over the global Happy DOM environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'must-login-castle-lock-'));
  const { fixture, key } = castleFixtures();
  const configUrl = 'https://abs.twimg.com/x-web/x-web/assets/BMpThmqI.js';
  fixture.set(configUrl, [fixture.get(configUrl)[0] + '\nconst m = new Map(); m.set(`Authorization`, `Bearer SHARED_CACHE_TOKEN`);']);
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
  const requests = [];
  const backend = fetchFor(fixture);
  const fetch = async url => {
    requests.push(String(url));
    return backend(url);
  };
  try {
    const common = { allowRemoteSdkExecution: true, fetch, cacheDirectory: directory, logger };
    const run = () => Promise.all([
      generateCastleToken(common),
      generateSign('jf', 'PATCH', common),
      getAuthorizationToken({ fetch, cacheDirectory: directory, logger }),
    ]);
    const [castle, sign, authorization] = await run();
    assert.equal(castle, `castle-token:${key}`);
    assert.equal(sign, 'jf:PATCH');
    assert.equal(authorization, 'Bearer SHARED_CACHE_TOKEN');

    const countsBefore = new Map(requests.map(url => [url, requests.filter(value => value === url).length]));
    assert.equal(countsBefore.get('https://x.com/'), 3);
    assert.equal(countsBefore.get('https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BadkwjBO.js'), 1);
    assert.equal([...countsBefore].filter(([url, count]) => url !== 'https://x.com/' && count !== 1).length, 0);

    assert.deepEqual(await run(), [castle, sign, authorization], 'Cached SDK source must remain usable with fresh DOM sessions');
    assert.equal(requests.filter(url => url === 'https://x.com/').length, 6, 'Every tool invocation must refetch HTML');
    for (const [url, count] of countsBefore) {
      if (url !== 'https://x.com/') assert.equal(requests.filter(value => value === url).length, count, `${url} should remain cached`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
