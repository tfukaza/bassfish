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
        "resourceId": "e3c140b7-4636-48ab-b1e5-949379859582",
        "previousRevision": "1",
        "revision": "2",
        "doltCommit": "su815l8nc61qhjpllr0ag7ch9jrk7e66",
        "messageId": "43453934-104f-4124-a160-41a7a20a914b",
        "sequence": "1"
      }
    },
    {
      "baseRevision": "2",
      "result": {
        "resourceId": "e3c140b7-4636-48ab-b1e5-949379859582",
        "previousRevision": "2",
        "revision": "3",
        "doltCommit": "1a3h8b6ht82qem0vguru2a3a86q44tne",
        "messageId": "c145a37a-d5bf-4137-a4cf-aac921e224ca",
        "sequence": "2"
      }
    },
    {
      "baseRevision": "3",
      "result": {
        "resourceId": "e3c140b7-4636-48ab-b1e5-949379859582",
        "previousRevision": "3",
        "revision": "4",
        "doltCommit": "r32j8obljnb01a9su1h91vf2hrqgdtde",
        "messageId": "13248678-cd42-4743-afb5-29e7faf7c701",
        "sequence": "3"
      }
    },
    {
      "baseRevision": "4",
      "result": {
        "resourceId": "e3c140b7-4636-48ab-b1e5-949379859582",
        "previousRevision": "4",
        "revision": "5",
        "doltCommit": "old0fd2ag9u4sf6suf4gl41ajmjupd0f",
        "messageId": "ad1aab33-d7fc-4f8e-9cfe-32f3fe0c31c9",
        "sequence": "4"
      }
    }
  ],
  "tests": {
    "passed": 3,
    "failed": 0,
    "stdout": "✔ existing /items still returns an array (0.401208ms)\n✔ /v2/items includes pagination metadata (0.332583ms)\n✔ client uses /v2/items and returns its items (0.07775ms)\nℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 39.823375\n"
  },
  "files": {
    "apiBefore": "const items = [{ id: 1, name: 'Field notes' }];\nexport function get(path) {\n  if (path === '/items') return items;\n  throw new Error('Route not found');\n}\n",
    "apiAfter": "const items = [{ id: 1, name: 'Field notes' }];\nexport function get(path) {\n  if (path === '/items') return items;\n  if (path === '/v2/items') return { items, total: items.length };\n  throw new Error('Route not found');\n}\n",
    "clientBefore": "import { get } from './api.mjs';\nexport function loadItems(request = get) {\n  return request('/items');\n}\n",
    "clientAfter": "import { get } from './api.mjs';\nexport function loadItems(request = get) {\n  return request('/v2/items').items;\n}\n",
    "testSource": "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {get} from './api.mjs';\nimport {loadItems} from './client.mjs';\ntest('existing /items still returns an array', () => {\n  assert(Array.isArray(get('/items')));\n  assert.equal(get('/items')[0].id, 1);\n});\ntest('/v2/items includes pagination metadata', () => {\n  const result = get('/v2/items');\n  assert.deepEqual(result, {items: get('/items'), total: 1});\n});\ntest('client uses /v2/items and returns its items', () => {\n  const calls = [];\n  const result = loadItems(path => { calls.push(path); return get(path); });\n  assert.deepEqual(calls, ['/v2/items']);\n  assert.deepEqual(result, get('/items'));\n});\n"
  }
};
