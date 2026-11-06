import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { getAuthorizationToken } from '../dist/index.js';

/** Construct a simulated fetch response containing its final URL. */
function response(url, content, contentType = 'text/javascript') {
  const result = new Response(content, { headers: { 'content-type': contentType } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

/** Count the number of network fetches for one exact URL. */
function countRequests(requests, url) {
  return requests.filter(value => value === url).length;
}

test('Authorization always reloads HTML while caching hashed assets, invalidating on new URLs and corrupt records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'must-login-cache-versioned-'));
  const prefix = 'https://abs.twimg.com/x-web/x-web/';
  const versions = [
    { entry: `${prefix}entry-client-logged-out-versionAA.js`, chunk: `${prefix}assets/chunkVersionAA.js`, bearer: 'Bearer VERSION_A' },
    { entry: `${prefix}entry-client-logged-out-versionBB.js`, chunk: `${prefix}assets/chunkVersionBB.js`, bearer: 'Bearer VERSION_B' },
  ];
  const assets = new Map();
  for (const version of versions) {
    assets.set(version.entry, `import "./assets/${version.chunk.split('/').at(-1)}";`);
    assets.set(version.chunk, `let headers = new Map(); headers.set("Authorization", "${version.bearer}");`);
  }
  const requests = [];
  const logEvents = [];
  const logger = {
    info() {}, warn() {}, error() {},
    debug(message, details) { logEvents.push([message, details]); },
  };
  let versionIndex = 0;
  const fetch = async url => {
    const target = String(url);
    requests.push(target);
    if (target === 'https://x.com/') {
      return response(target, `<html><script>var entryHref = "${versions[versionIndex].entry}";</script></html>`, 'text/html');
    }
    const asset = assets.get(target);
    assert.ok(asset, `Unexpected CDN request: ${target}`);
    return response(target, asset);
  };

  try {
    const options = { cacheDirectory: directory, fetch, logger, verbose: true };
    assert.equal(await getAuthorizationToken(options), 'Bearer VERSION_A');
    assert.equal(await getAuthorizationToken(options), 'Bearer VERSION_A');
    assert.equal(countRequests(requests, 'https://x.com/'), 2);
    assert.equal(countRequests(requests, versions[0].entry), 1);
    assert.equal(countRequests(requests, versions[0].chunk), 1);
    assert.ok(logEvents.some(([event]) => event === 'CDN 缓存命中'));

    versionIndex = 1;
    assert.equal(await getAuthorizationToken(options), 'Bearer VERSION_B');
    assert.equal(countRequests(requests, 'https://x.com/'), 3);
    assert.equal(countRequests(requests, versions[1].entry), 1);
    assert.equal(countRequests(requests, versions[1].chunk), 1);
    assert.equal(countRequests(requests, versions[0].chunk), 1);

    // Corruption forces only the affected asset to be downloaded again.
    const urlHash = createHash('sha256').update(versions[1].chunk).digest('hex');
    const recordDirectory = join(directory, 'assets', urlHash.slice(0, 2));
    await mkdir(recordDirectory, { recursive: true });
    await writeFile(join(recordDirectory, `${urlHash}.json`), '{incomplete JSON');

    assert.equal(await getAuthorizationToken(options), 'Bearer VERSION_B');
    assert.equal(countRequests(requests, 'https://x.com/'), 4);
    assert.equal(countRequests(requests, versions[1].entry), 1);
    assert.equal(countRequests(requests, versions[1].chunk), 2);
    assert.equal(JSON.stringify(logEvents).includes('Bearer VERSION_B'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
