export const demo = {
  "messages": [
    {
      "name": "api-agent",
      "body": "Adding pagination: /items will return { items, total }.",
      "sequence": "1"
    },
    {
      "name": "client-agent",
      "body": "loadItems() expects an array. Keep /items; add /v2/items.",
      "sequence": "2"
    },
    {
      "name": "api-agent",
      "body": "Agreed. /items stays unchanged. Adding /v2/items.",
      "sequence": "3"
    },
    {
      "name": "client-agent",
      "body": "I'll switch loadItems() to /v2/items.",
      "sequence": "4"
    }
  ],
  "writes": [
    {
      "revisionRead": "1",
      "result": {
        "threadId": "7f0f6e7c-60ea-45e9-847f-5ae2bca1fc31",
        "revision": "2",
        "messageId": "a9fdf8d3-4a30-41d5-9a28-37b86520bc2f",
        "sequence": "1"
      }
    },
    {
      "revisionRead": "2",
      "result": {
        "threadId": "7f0f6e7c-60ea-45e9-847f-5ae2bca1fc31",
        "revision": "3",
        "messageId": "bd988659-c7c5-4153-a85d-2d7c6b071831",
        "sequence": "2"
      }
    },
    {
      "revisionRead": "3",
      "result": {
        "threadId": "7f0f6e7c-60ea-45e9-847f-5ae2bca1fc31",
        "revision": "4",
        "messageId": "030a0701-5edb-4794-9d12-470390040232",
        "sequence": "3"
      }
    },
    {
      "revisionRead": "4",
      "result": {
        "threadId": "7f0f6e7c-60ea-45e9-847f-5ae2bca1fc31",
        "revision": "5",
        "messageId": "b8d6eef1-aa42-467e-a475-41112d8be81f",
        "sequence": "4"
      }
    }
  ],
  "tests": {
    "passed": 3,
    "failed": 0,
    "stdout": "✔ existing /items still returns an array (0.315ms)\n✔ /v2/items includes pagination metadata (0.268875ms)\n✔ client uses /v2/items and returns its items (0.058459ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 30.49925\n"
  },
  "files": {
    "apiBefore": "const items = [{ id: 1, name: 'Field notes' }];\nexport function get(path) {\n  if (path === '/items') return items;\n  throw new Error('Route not found');\n}\n",
    "apiAfter": "const items = [{ id: 1, name: 'Field notes' }];\nexport function get(path) {\n  if (path === '/items') return items;\n  if (path === '/v2/items') return { items, total: items.length };\n  throw new Error('Route not found');\n}\n",
    "clientBefore": "import { get } from './api.mjs';\nexport function loadItems(request = get) {\n  return request('/items');\n}\n",
    "clientAfter": "import { get } from './api.mjs';\nexport function loadItems(request = get) {\n  return request('/v2/items').items;\n}\n",
    "testSource": "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {get} from './api.mjs';\nimport {loadItems} from './client.mjs';\ntest('existing /items still returns an array', () => {\n  assert(Array.isArray(get('/items')));\n  assert.equal(get('/items')[0].id, 1);\n});\ntest('/v2/items includes pagination metadata', () => {\n  const result = get('/v2/items');\n  assert.deepEqual(result, {items: get('/items'), total: 1});\n});\ntest('client uses /v2/items and returns its items', () => {\n  const calls = [];\n  const result = loadItems(path => { calls.push(path); return get(path); });\n  assert.deepEqual(calls, ['/v2/items']);\n  assert.deepEqual(result, get('/items'));\n});\n"
  }
};
