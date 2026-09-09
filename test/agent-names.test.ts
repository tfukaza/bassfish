import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedAgentNames, selectGeneratedAgentName } from '../src/agent-names.js';
import { nameSchema } from '../src/contracts.js';

test('the generated aquatic name pool is fixed, valid, and case-insensitively unique', () => {
  assert.equal(generatedAgentNames.length, 256);
  assert.equal(
    new Set(generatedAgentNames.map(name => name.toLowerCase())).size,
    generatedAgentNames.length,
  );
  for (const name of generatedAgentNames)
    assert.equal(nameSchema.safeParse(name).success, true, name);
  assert.equal(
    generatedAgentNames.some(name => name.toLowerCase() === 'here'),
    false,
  );
});

test('generated names are selected only from names never registered in the repository', () => {
  assert.equal(
    selectGeneratedAgentName([], () => 0),
    'AzureAnchovy',
  );
  assert.equal(
    selectGeneratedAgentName(['azureanchovy'], () => 0),
    'AzureBass',
  );
  assert.equal(
    selectGeneratedAgentName(generatedAgentNames, () => 0),
    undefined,
  );
  assert.throws(() => selectGeneratedAgentName([], () => generatedAgentNames.length), RangeError);
});
