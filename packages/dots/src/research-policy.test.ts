import { expect, test } from 'bun:test';
import {
  createDotResearchPolicy,
  rehydrateDotResearchPolicy,
  type DotResearchPolicyInput,
} from './research-policy';
const input: DotResearchPolicyInput = {
  id: 'policy',
  dotId: 'dot',
  createdAt: 1,
  expiresAt: 3600001,
  provider: { id: 'model', baseUrl: 'https://example.test/v1', model: 'fixture' },
  configurationRevision: 7,
  queries: [{ query: 'bounded question', maxResults: 3 }],
  allowDiscoveredPages: true,
  limits: {
    maxRuns: 3,
    maxSearches: 6,
    maxFetches: 6,
    maxResponseBytes: 8 * 1024 * 1024,
    maxModelTurns: 24,
    maxModelRequestBytes: 24 * 96 * 1024,
  },
};
test('research policy is immutable exact scope and survives strict JSON rehydration', () => {
  const policy = createDotResearchPolicy(input);
  expect(rehydrateDotResearchPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
  expect(Object.isFrozen(policy.queries[0])).toBe(true);
  expect(Object.isFrozen(policy.limits)).toBe(true);
  expect(() =>
    createDotResearchPolicy({ ...input, queries: [{ query: ' bounded question', maxResults: 3 }] }),
  ).toThrow();
  expect(() => createDotResearchPolicy({ ...input, expiresAt: 1 + 8 * 86400000 })).toThrow();
  expect(() =>
    createDotResearchPolicy({ ...input, limits: { ...input.limits, maxRuns: 101 } }),
  ).toThrow();
  expect(() =>
    createDotResearchPolicy({ ...input, queries: [...input.queries, ...input.queries] }),
  ).toThrow();
});
test('policy accessors, sparse arrays and unexpected permissions cannot enter domain state', () => {
  let invoked = 0;
  const getter = { ...input };
  Object.defineProperty(getter, 'queries', {
    enumerable: true,
    get: () => {
      invoked++;
      return [];
    },
  });
  expect(() => createDotResearchPolicy(getter)).toThrow();
  expect(invoked).toBe(0);
  const policy = createDotResearchPolicy(input);
  expect(() => rehydrateDotResearchPolicy({ ...policy, shell: true })).toThrow();
  expect(() => createDotResearchPolicy({ ...input, queries: new Array(1) })).toThrow();
  expect(() => rehydrateDotResearchPolicy({ ...policy, status: 'revoked', revision: 0 })).toThrow();
});
