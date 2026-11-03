'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLoginClient } = require('../dist/index.cjs');

test('CommonJS require loads the built package entry', async () => {
  const client = createLoginClient(({ username }) => ({ user: username }));
  assert.deepEqual(await client.login({ username: 'eason', password: 'example' }), {
    user: 'eason',
  });
});
