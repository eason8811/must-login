'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { generateSign, generateCastleToken, getAuthorizationToken } = require('../dist/index.cjs');

test('CommonJS require resolves the public SDK tool', async () => {
  assert.equal(typeof generateSign, 'function');
  assert.equal(typeof generateCastleToken, 'function');
  assert.equal(typeof getAuthorizationToken, 'function');
  await assert.rejects(generateSign(), /allowRemoteSdkExecution/);
  await assert.rejects(generateCastleToken(), /allowRemoteSdkExecution/);
});

test('CommonJS require extracts Authorization through the hashed Entry import without SDK execution', async () => {
  const entry = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BadkwjBO.js';
  const chunk = 'https://abs.twimg.com/x-web/x-web/assets/DFhr1Vbc.js';
  const files = new Map([
    ['https://x.com/', [`<html><script>var entryHref = "${entry}"</script></html>`, 'text/html']],
    [entry, ['import { foo } from "./assets/DFhr1Vbc.js";', 'text/javascript']],
    [chunk, ['const map = new Map();map.set(`Authorization`, `Bearer AAAAA_CJS_TEST%3D`);', 'text/javascript']],
  ]);
  const authorization = await getAuthorizationToken({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fetch: async url => {
      const file = files.get(String(url));
      assert.ok(file, `Unexpected URL: ${url}`);
      const result = new Response(file[0], { headers: { 'content-type': file[1] } });
      Object.defineProperty(result, 'url', { value: String(url) });
      return result;
    },
  });
  assert.equal(authorization, 'Bearer AAAAA_CJS_TEST%3D');
});

test('CommonJS require can execute the complete offline SDK chain', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'must-login-cjs-'));
  const entry = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-c1.js';
  const decoy = 'https://abs.twimg.com/x-web/x-web/assets/BFxGKRfh.js';
  const startup = 'https://abs.twimg.com/x-web/x-web/assets/dSSXoMgG.js';
  const sdk = 'https://abs.twimg.com/x-web/x-web/assets/CYgkI3Mb.js';
  const runtime = 'https://abs.twimg.com/x-web/x-web/assets/B644W4is.js';
  const svgs = Array.from({ length: 4 }, (_, i) =>
    `<svg id="loading-x-anim-${i}"><g><rect/><path d="M0 0"/></g></svg>`,
  ).join('');
  const html = `<html><head><meta name="twitter-site-verification" content="YWJjZGVmZ2g="/><script src="${entry}"></script></head><body>${svgs}</body></html>`;
  const assets = new Map([
    ['https://x.com/', [html, 'text/html']],
    [entry, [
      'import "./assets/BFxGKRfh.js"; import { d as x } from "./assets/dSSXoMgG.js";',
      'text/javascript',
    ]],
    [decoy, ['export const other = true;', 'text/javascript']],
    [startup, [
      'function Zm(){return import(`./CYgkI3Mb.js`).then(e=>e.default())}\n' +
      'function Qm(e){return e === `jf.x.com` || e.endsWith(`.jf.x.com`) ? `PATCH` : `GET`}',
      'text/javascript',
    ]],
    [sdk, [
      'import { runtimeLoaded } from "./B644W4is.js";\n' +
      'export default () => (input, method) => runtimeLoaded ? `${input}-${method}` : "MISSING_RUNTIME";',
      'text/javascript',
    ]],
    [runtime, ['export const runtimeLoaded = true;', 'text/javascript']],
  ]);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    const signature = await generateSign('jf', 'PATCH', {
      allowRemoteSdkExecution: true,
      cacheDirectory,
      logger,
      fetch: async url => {
        const asset = assets.get(String(url));
        assert.ok(asset, `Unexpected URL: ${url}`);
        const response = new Response(asset[0], { headers: { 'content-type': asset[1] } });
        Object.defineProperty(response, 'url', { value: String(url) });
        return response;
      },
    });
    assert.equal(signature, 'jf-PATCH');
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test('CommonJS require can discover the Castle SDK/key and generate a token', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'must-login-castle-cjs-'));
  const entry = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-abc123.js';
  const startup = 'https://abs.twimg.com/x-web/x-web/assets/hashed01.js';
  const config = 'https://abs.twimg.com/x-web/x-web/assets/hashed02.js';
  const sdk = 'https://abs.twimg.com/x-web/x-web/assets/hashed03.js';
  const runtime = 'https://abs.twimg.com/x-web/x-web/assets/cnfsMYm8.js';
  const assets = new Map([
    ['https://x.com/', [`<html><head><script>var entryHref = "${entry}";</script></head><body></body></html>`, 'text/html']],
    [entry, ['import "./assets/hashed01.js";']],
    [startup, [[
      'import "./hashed02.js"; function DN(t) { if (!t.isTrue(`responsive_web_castle_sdk_enabled`)) return;',
      'let n=t.getStringValue(`responsive_web_castle_public_key`);',
      'return import(`./hashed03.js`).then(e => e.default.configure({pk:n})); }',
    ].join('\n')]],
    [config, ['export default { responsive_web_castle_public_key: `pk_CJS123456789` };']],
    [sdk, [
      'import { runtimeName } from "./cnfsMYm8.js";\n' +
      'export default { configure({pk}) {this.pk=pk;}, createRequestToken() {return `${this.pk}:${runtimeName}`;} };',
    ]],
    [runtime, ['export const runtimeName = "cjs-runtime";']],
  ]);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  try {
    const token = await generateCastleToken({
      allowRemoteSdkExecution: true,
      logger,
      cacheDirectory,
      fetch: async url => {
        const value = assets.get(String(url));
        assert.ok(value, `Unexpected asset: ${url}`);
        const result = new Response(value[0], { headers: { 'content-type': value[1] ?? 'text/javascript' } });
        Object.defineProperty(result, 'url', { value: String(url) });
        return result;
      },
    });
    assert.equal(token, 'pk_CJS123456789:cjs-runtime');
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
