'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { generateSign } = require('../dist/index.cjs');

test('CommonJS require resolves the public SDK tool', async () => {
  assert.equal(typeof generateSign, 'function');
  await assert.rejects(generateSign(), /allowRemoteSdkExecution/);
});

test('CommonJS require can execute the complete offline SDK chain', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'must-login-cjs-'));
  const entry = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-c1.js';
  const startup = 'https://abs.twimg.com/x-web/x-web/assets/startup-dynamic-c2.js';
  const sdk = 'https://abs.twimg.com/x-web/x-web/assets/sign.o-c3.js';
  const svgs = Array.from({ length: 4 }, (_, i) =>
    `<svg id="loading-x-anim-${i}"><g><rect/><path d="M0 0"/></g></svg>`,
  ).join('');
  const html = `<html><head><meta name="twitter-site-verification" content="YWJjZGVmZ2g="/><script src="${entry}"></script></head><body>${svgs}</body></html>`;
  const assets = new Map([
    ['https://x.com/', [html, 'text/html']],
    [entry, ['"./assets/startup-dynamic-c2.js"', 'text/javascript']],
    [startup, ['"./sign.o-c3.js"', 'text/javascript']],
    [sdk, ['export default () => (input, method) => `${input}-${method}`;', 'text/javascript']],
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
