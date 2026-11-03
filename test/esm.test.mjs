import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoginClient } from '../dist/index.js';

test('ESM import loads the built package entry', async () => {
  const client = createLoginClient(async ({ username }) => ({ user: username }));
  assert.deepEqual(await client.login({ username: 'eason', password: 'example' }), {
    user: 'eason',
  });
});
