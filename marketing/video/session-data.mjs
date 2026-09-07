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
      "baseRevision": "1",
      "result": {
        "resource_id": "b3cadb09-27e0-4977-9dbd-4b7c18dbc507",
        "previous_revision": "1",
        "revision": "2",
        "dolt_commit": "4l3fbpdm6ofguv8oh2607o95m2glvkis",
        "message_id": "8a940f6a-f14e-4008-992a-d71c7bf77bfe",
        "sequence": "1"
      }
    },
    {
      "baseRevision": "2",
      "result": {
        "resource_id": "b3cadb09-27e0-4977-9dbd-4b7c18dbc507",
        "previous_revision": "2",
        "revision": "3",
        "dolt_commit": "r870h1su2a22gjmptk53msrnii7remu4",
        "message_id": "11ec5bce-fe0a-4aa8-8608-76c9a3a4e9cb",
        "sequence": "2"
      }
    },
    {
      "baseRevision": "3",
      "result": {
        "resource_id": "b3cadb09-27e0-4977-9dbd-4b7c18dbc507",
        "previous_revision": "3",
        "revision": "4",
        "dolt_commit": "i6umaojv0qi1n9jbsuamcnlbho6gb60g",
        "message_id": "b86f1f07-55c9-4df4-88a1-4707a6245d9a",
        "sequence": "3"
      }
    },
    {
      "baseRevision": "4",
      "result": {
        "resource_id": "b3cadb09-27e0-4977-9dbd-4b7c18dbc507",
        "previous_revision": "4",
        "revision": "5",
        "dolt_commit": "uuhj1ii28i1hklpf64nvmipda9r3ig5m",
        "message_id": "1e044742-b541-4516-be8e-02e41a2ed7d4",
        "sequence": "4"
      }
    }
  ],
  "tests": {
    "passed": 3,
    "failed": 0,
    "stdout": "✔ existing /items still returns an array (0.285917ms)\n✔ /v2/items includes pagination metadata (0.249042ms)\n✔ client uses /v2/items and returns its items (0.056292ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 35.789125\n"
  },
  "files": {
    "apiBefore": "const items = [{ id: 1, name: 'Field notes' }];\nexport function get(path) {\n  if (path === '/items') return items;\n  throw new Error('Route not found');\n}\n",
    "apiAfter": "const items = [{ id: 1, name: 'Field notes' }];\nexport function get(path) {\n  if (path === '/items') return items;\n  if (path === '/v2/items') return { items, total: items.length };\n  throw new Error('Route not found');\n}\n",
    "clientBefore": "import { get } from './api.mjs';\nexport function loadItems(request = get) {\n  return request('/items');\n}\n",
    "clientAfter": "import { get } from './api.mjs';\nexport function loadItems(request = get) {\n  return request('/v2/items').items;\n}\n",
    "testSource": "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {get} from './api.mjs';\nimport {loadItems} from './client.mjs';\ntest('existing /items still returns an array', () => {\n  assert(Array.isArray(get('/items')));\n  assert.equal(get('/items')[0].id, 1);\n});\ntest('/v2/items includes pagination metadata', () => {\n  const result = get('/v2/items');\n  assert.deepEqual(result, {items: get('/items'), total: 1});\n});\ntest('client uses /v2/items and returns its items', () => {\n  const calls = [];\n  const result = loadItems(path => { calls.push(path); return get(path); });\n  assert.deepEqual(calls, ['/v2/items']);\n  assert.deepEqual(result, get('/items'));\n});\n"
  }
};
