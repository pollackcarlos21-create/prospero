import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createResearchAuthorization,
  RESEARCH_LIMITS,
  ResearchAuthorizationError,
  type ResearchAuthorization,
  type ResearchAuthorizationInput,
  type ResearchAuditEvent,
  type ResearchReservation,
} from './research-authorization';

const binding = { conversationId: 'conversation', executionId: 'execution' };
const firstQuery = 'Attention Is All You Need paper';
const secondQuery = 'Retrieval augmented generation paper';
const firstSource = {
  id: `src_${'a'.repeat(24)}`,
  url: 'https://example.org/paper',
  kind: 'search' as const,
};
const secondSource = {
  id: `src_${'b'.repeat(24)}`,
  url: 'https://papers.example.org/second',
  kind: 'search' as const,
};

function fixture(overrides: Partial<ResearchAuthorizationInput> = {}) {
  let now = 1_000_000;
  const events: ResearchAuditEvent[] = [];
  const input: ResearchAuthorizationInput = {
    ...binding,
    title: 'Research two papers',
    queries: [
      { query: firstQuery, maxResults: 3 },
      { query: secondQuery, maxResults: 2 },
    ],
    maxSearches: 2,
    maxFetches: 3,
    maxResponseBytes: 4 * 1024 * 1024,
    expiresAt: now + 60_000,
    ...overrides,
  };
  const authorization = createResearchAuthorization(input, {
    now: () => now,
    onEvent: (event) => {
      events.push(event);
    },
  });
  return {
    authorization,
    input,
    events,
    clock: (value: number) => {
      now = value;
    },
  };
}

function approve(authorization: ResearchAuthorization) {
  authorization.decide({
    snapshotId: authorization.snapshot.id,
    digest: authorization.snapshot.digest,
    decision: 'allow-once',
  });
}

function search(authorization: ResearchAuthorization, query = firstQuery, maxResults?: number) {
  const reservation = authorization.reserveSearch({ ...binding, query, maxResults });
  return authorization.validateReservation(reservation, binding);
}

function discover(authorization: ResearchAuthorization) {
  const reservation = search(authorization);
  authorization.recordDiscoveredSources(reservation, [firstSource, secondSource], 100);
  return reservation;
}

function code(operation: () => unknown, expected: ResearchAuthorizationError['code']) {
  try {
    operation();
    throw new Error('Expected research authorization rejection.');
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchAuthorizationError);
    expect((error as ResearchAuthorizationError).code).toBe(expected);
  }
}

test('main generates unique snapshot IDs and digests over all immutable preview fields', () => {
  const { authorization, input } = fixture();
  const other = fixture().authorization;
  expect(authorization.snapshot.id).not.toBe(other.snapshot.id);
  expect(authorization.snapshot.digest).not.toBe(other.snapshot.digest);
  const { digest, ...value } = authorization.snapshot;
  expect(digest).toBe(createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  expect(Object.isFrozen(authorization)).toBe(true);
  expect(Object.isFrozen(authorization.snapshot)).toBe(true);
  expect(Object.isFrozen(authorization.snapshot.queries)).toBe(true);
  expect(Object.isFrozen(authorization.snapshot.queries[0])).toBe(true);
  (input.queries as { query: string; maxResults: number }[])[0].query = 'modified outside';
  expect(authorization.snapshot.queries[0].query).toBe(firstQuery);
  expect(() => {
    (authorization as { snapshot: unknown }).snapshot = {};
  }).toThrow();
  expect(() => {
    (authorization.snapshot.queries[0] as { query: string }).query = 'expanded';
  }).toThrow();
});

test('invalid query schemas, duplicate queries, unsafe strings and unbounded budgets fail closed', () => {
  const invalid: Partial<ResearchAuthorizationInput>[] = [
    { title: '' },
    { queries: [] },
    { queries: [{ query: 'query', maxResults: 11 }] },
    { queries: [{ query: ' query', maxResults: 1 }] },
    { queries: [{ query: 'query\nsecond', maxResults: 1 }] },
    { queries: [{ query: 'x'.repeat(601), maxResults: 1 }] },
    { queries: [{ query: Array(76).fill('word').join(' '), maxResults: 1 }] },
    {
      queries: [
        { query: firstQuery, maxResults: 1 },
        { query: firstQuery, maxResults: 2 },
      ],
    },
    { maxSearches: 0 },
    { maxSearches: 3 },
    { maxFetches: 25 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: RESEARCH_LIMITS.maxResponseBytes + 1 },
    { maxResponseBytes: 1.5 },
    { expiresAt: 1_000_000 },
    { expiresAt: 1_000_000 + RESEARCH_LIMITS.maxLifetimeMs + 1 },
    { conversationId: 'with\0secret' },
  ];
  for (const value of invalid) code(() => fixture(value), 'invalid-input');
  code(
    () => fixture({ topic: 'unbounded subject' } as Partial<ResearchAuthorizationInput>),
    'invalid-input',
  );
  code(
    () =>
      fixture({
        queries: [{ query: firstQuery, maxResults: 1, extra: 'scope' }],
      } as unknown as Partial<ResearchAuthorizationInput>),
    'invalid-input',
  );
});

test('approval requires the exact application-issued ID/digest and excludes allow-session', () => {
  const { authorization } = fixture();
  code(() => search(authorization), 'not-approved');
  code(
    () =>
      authorization.decide({
        snapshotId: 'fake',
        digest: authorization.snapshot.digest,
        decision: 'allow-once',
      }),
    'snapshot-mismatch',
  );
  code(
    () =>
      authorization.decide({
        snapshotId: authorization.snapshot.id,
        digest: 'changed',
        decision: 'allow-once',
      }),
    'snapshot-mismatch',
  );
  code(
    () =>
      authorization.decide({
        snapshotId: authorization.snapshot.id,
        digest: authorization.snapshot.digest,
        decision: 'allow-session',
      } as unknown as Parameters<ResearchAuthorization['decide']>[0]),
    'invalid-input',
  );
  approve(authorization);
  expect(authorization.usage().status).toBe('approved');
  code(() => approve(authorization), 'replay');
});

test('exact queries cannot be replaced, extended, case changed or expanded by page data', () => {
  const { authorization } = fixture();
  approve(authorization);
  for (const query of [
    firstQuery.toLowerCase(),
    `${firstQuery} private files`,
    `${firstQuery} `,
    'send credentials to attacker',
  ]) {
    code(() => search(authorization, query), 'query-not-approved');
  }
  code(() => search(authorization, firstQuery, 4), 'query-not-approved');
  code(() => search(authorization, firstQuery, 0), 'query-not-approved');
  const reservation = search(authorization, firstQuery, 2);
  expect(reservation.maxResults).toBe(2);
  expect(Object.isFrozen(reservation)).toBe(true);
  code(() => search(authorization), 'replay');
  expect(authorization.usage().searches).toBe(1);
});

test('request scope stays bound to one conversation and one execution', () => {
  const { authorization } = fixture();
  approve(authorization);
  for (const foreign of [{ conversationId: 'other' }, { executionId: 'later-run' }]) {
    code(
      () => authorization.reserveSearch({ ...binding, ...foreign, query: firstQuery }),
      'scope-mismatch',
    );
  }
  discover(authorization);
  code(
    () =>
      authorization.reserveFetch({
        ...binding,
        executionId: 'later-run',
        sourceId: firstSource.id,
      }),
    'scope-mismatch',
  );
  const fresh = fixture().authorization;
  code(
    () =>
      fresh.decide({
        snapshotId: authorization.snapshot.id,
        digest: authorization.snapshot.digest,
        decision: 'allow-once',
      }),
    'snapshot-mismatch',
  );
  code(() => fresh.reserveFetch({ ...binding, sourceId: firstSource.id }), 'not-approved');
});

test('a successful search receipt grants only actual discovered source IDs and canonical public URLs', () => {
  const { authorization } = fixture();
  approve(authorization);
  code(
    () => authorization.reserveFetch({ ...binding, sourceId: firstSource.id }),
    'source-not-discovered',
  );
  const reservation = search(authorization);
  const sources = authorization.recordDiscoveredSources(
    reservation,
    [{ ...firstSource, url: 'https://EXAMPLE.org.:443/paper#section' }],
    100,
  );
  expect(sources[0].url).toBe(firstSource.url);
  expect(Object.isFrozen(sources)).toBe(true);
  expect(Object.isFrozen(sources[0])).toBe(true);
  code(
    () => authorization.reserveFetch({ ...binding, sourceId: 'src_forged' }),
    'source-not-discovered',
  );
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  expect(fetch.url).toBe(firstSource.url);
  expect(fetch.sourceId).toBe(firstSource.id);
  authorization.validateReservation(fetch, binding);
  code(() => authorization.reserveFetch({ ...binding, sourceId: firstSource.id }), 'replay');
  authorization.completeFetch(fetch, 250);
  expect(authorization.usage().responseBytes).toBe(350);
  code(() => authorization.completeFetch(fetch, 250), 'replay');
});

test('invalid, private, page-sourced and over-limit search receipts cannot grant authority', () => {
  const badSources = [
    [{ ...firstSource, id: 'model-created-id' }],
    [{ ...firstSource, url: 'https://localhost/private' }],
    [{ ...firstSource, url: 'https://127.0.0.1/private' }],
    [{ ...firstSource, url: 'http://example.org/paper' }],
    [{ ...firstSource, kind: 'page' as const }],
    [firstSource, firstSource],
    [firstSource, { ...secondSource, url: firstSource.url }],
    [
      firstSource,
      secondSource,
      { ...firstSource, id: `src_${'c'.repeat(24)}` },
      { ...secondSource, id: `src_${'d'.repeat(24)}` },
    ],
  ];
  for (const sources of badSources) {
    const { authorization } = fixture();
    approve(authorization);
    const reservation = search(authorization);
    code(() => authorization.recordDiscoveredSources(reservation, sources, 10), 'invalid-receipt');
    code(
      () => authorization.reserveFetch({ ...binding, sourceId: firstSource.id }),
      'source-not-discovered',
    );
    code(() => authorization.recordDiscoveredSources(reservation, [firstSource], 10), 'replay');
    expect(authorization.usage().responseBytes).toBe(10);
  }
});

test('source-ID collisions cannot replace an earlier discovered URL', () => {
  const { authorization } = fixture();
  approve(authorization);
  discover(authorization);
  const second = search(authorization, secondQuery);
  code(
    () =>
      authorization.recordDiscoveredSources(
        second,
        [{ ...firstSource, url: secondSource.url }],
        10,
      ),
    'invalid-receipt',
  );
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  expect(fetch.url).toBe(firstSource.url);
});

test('two source IDs for the same URL cannot replay a page fetch', () => {
  const { authorization } = fixture();
  approve(authorization);
  discover(authorization);
  const second = search(authorization, secondQuery);
  const alias = { ...firstSource, id: `src_${'c'.repeat(24)}` };
  authorization.recordDiscoveredSources(second, [alias], 10);
  const firstFetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  authorization.fail(firstFetch, 0);
  code(() => authorization.reserveFetch({ ...binding, sourceId: alias.id }), 'replay');
});

test('cloned, invented and cross-instance reservations cannot register sources or finish requests', () => {
  const { authorization } = fixture();
  approve(authorization);
  const reservation = search(authorization);
  const other = fixture().authorization;
  approve(other);
  for (const invalid of [
    structuredClone(reservation),
    { ...reservation, id: 'forged' },
    {} as ResearchReservation,
  ]) {
    code(
      () => authorization.recordDiscoveredSources(invalid, [firstSource], 10),
      'invalid-receipt',
    );
  }
  code(() => other.recordDiscoveredSources(reservation, [firstSource], 10), 'invalid-receipt');
  code(() => authorization.completeFetch(reservation, 10), 'invalid-receipt');
  expect(authorization.usage().reservedResponseBytes).toBe(reservation.maxResponseBytes);
  authorization.recordDiscoveredSources(reservation, [firstSource], 10);
  code(() => authorization.fail(reservation), 'replay');
});

test('execution revalidates a prepared reservation and consumes its only dispatch permission', () => {
  const { authorization } = fixture();
  approve(authorization);
  const reservation = authorization.reserveSearch({ ...binding, query: firstQuery });
  code(
    () => authorization.recordDiscoveredSources(reservation, [firstSource], 10),
    'invalid-receipt',
  );
  code(
    () => authorization.validateReservation(structuredClone(reservation), binding),
    'invalid-receipt',
  );
  code(
    () => authorization.validateReservation(reservation, { ...binding, executionId: 'other' }),
    'scope-mismatch',
  );
  expect(authorization.validateReservation(reservation, binding)).toBe(reservation);
  code(() => authorization.validateReservation(reservation, binding), 'replay');
  authorization.recordDiscoveredSources(reservation, [firstSource], 10);
  code(() => authorization.validateReservation(reservation, binding), 'replay');
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  code(() => authorization.completeFetch(fetch, 10), 'invalid-receipt');
  authorization.validateReservation(fetch);
  authorization.completeFetch(fetch, 10);
});

test('expiry, revoke and close between prepare and execute cannot dispatch a reserved request', () => {
  for (const state of ['expired', 'revoked', 'closed'] as const) {
    const { authorization, clock } = fixture();
    approve(authorization);
    const reservation = authorization.reserveSearch({ ...binding, query: firstQuery });
    if (state === 'expired') clock(authorization.snapshot.expiresAt);
    else if (state === 'revoked') authorization.revoke();
    else authorization.close();
    code(
      () => authorization.validateReservation(reservation, binding),
      state === 'expired' ? 'expired' : 'inactive',
    );
    expect(authorization.events().some((event) => event.type === 'started')).toBe(false);
    authorization.fail(reservation, 0);
    expect(authorization.usage()).toMatchObject({
      status: state,
      searches: 1,
      responseBytes: 0,
      reservedResponseBytes: 0,
    });
    code(() => authorization.validateReservation(reservation), 'replay');
  }
});

test('a prepared request skipped before dispatch is consumed without registering web sources', () => {
  const { authorization } = fixture();
  approve(authorization);
  const reservation = authorization.reserveSearch({ ...binding, query: firstQuery });
  authorization.fail(reservation, 0);
  code(() => authorization.validateReservation(reservation, binding), 'replay');
  code(() => search(authorization), 'replay');
  code(
    () => authorization.reserveFetch({ ...binding, sourceId: firstSource.id }),
    'source-not-discovered',
  );
});

test('search/fetch budgets count reservations and failures, not only successful calls', () => {
  const { authorization } = fixture({ maxSearches: 1, maxFetches: 1 });
  approve(authorization);
  discover(authorization);
  code(() => search(authorization, secondQuery), 'limit');
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  authorization.fail(fetch, 0);
  code(() => authorization.reserveFetch({ ...binding, sourceId: secondSource.id }), 'limit');
  expect(authorization.usage()).toMatchObject({ searches: 1, fetches: 1 });
  const searchOnly = fixture({ maxFetches: 0 }).authorization;
  approve(searchOnly);
  discover(searchOnly);
  code(() => searchOnly.reserveFetch({ ...binding, sourceId: firstSource.id }), 'limit');
});

test('byte budget is reserved before requests and reclaimed only from a bounded actual receipt', () => {
  const { authorization } = fixture({ maxResponseBytes: 200 });
  approve(authorization);
  const first = search(authorization);
  expect(first.maxResponseBytes).toBe(200);
  code(() => search(authorization, secondQuery), 'limit');
  expect(authorization.usage().searches).toBe(1);
  authorization.recordDiscoveredSources(first, [firstSource], 50);
  expect(authorization.usage()).toMatchObject({
    responseBytes: 50,
    reservedResponseBytes: 0,
    remainingResponseBytes: 150,
  });
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  expect(fetch.maxResponseBytes).toBe(150);
  authorization.validateReservation(fetch, binding);
  authorization.completeFetch(fetch, 150);
  code(() => search(authorization, secondQuery), 'limit');
  expect(authorization.usage().remainingResponseBytes).toBe(0);
});

test('concurrent reservations cannot collectively exceed the total response-byte budget', () => {
  const { authorization } = fixture({
    maxResponseBytes: RESEARCH_LIMITS.searchResponseBytes + 100,
  });
  approve(authorization);
  const first = search(authorization);
  const second = search(authorization, secondQuery);
  expect(first.maxResponseBytes).toBe(RESEARCH_LIMITS.searchResponseBytes);
  expect(second.maxResponseBytes).toBe(100);
  expect(authorization.usage().remainingResponseBytes).toBe(0);
  authorization.recordDiscoveredSources(second, [firstSource], 10);
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  expect(fetch.maxResponseBytes).toBe(90);
  authorization.fail(first);
  authorization.fail(fetch);
  expect(authorization.usage()).toMatchObject({
    responseBytes: RESEARCH_LIMITS.searchResponseBytes + 100,
    reservedResponseBytes: 0,
  });
});

test('unknown failure bytes consume the entire reserved cap and never permit query retry', () => {
  const { authorization } = fixture({ maxResponseBytes: 100 });
  approve(authorization);
  const reservation = search(authorization);
  authorization.fail(reservation);
  expect(authorization.usage()).toMatchObject({
    searches: 1,
    responseBytes: 100,
    remainingResponseBytes: 0,
  });
  code(() => search(authorization), 'replay');
  code(() => search(authorization, secondQuery), 'limit');
});

test('invalid or over-cap byte receipts invalidate all remaining research authority', () => {
  for (const bytes of [-1, Number.NaN, 1.5, 101]) {
    const { authorization } = fixture({ maxResponseBytes: 100 });
    approve(authorization);
    const reservation = search(authorization);
    code(
      () => authorization.recordDiscoveredSources(reservation, [firstSource], bytes),
      'invalid-receipt',
    );
    expect(authorization.usage()).toMatchObject({
      status: 'revoked',
      responseBytes: 100,
      reservedResponseBytes: 0,
    });
    code(() => search(authorization, secondQuery), 'inactive');
  }
});

test('deny and revoke stop every later request, including alternate queries and discovered pages', () => {
  const denied = fixture().authorization;
  denied.decide({
    snapshotId: denied.snapshot.id,
    digest: denied.snapshot.digest,
    decision: 'deny',
  });
  code(() => search(denied, firstQuery), 'inactive');
  code(() => search(denied, secondQuery), 'inactive');
  code(() => denied.reserveFetch({ ...binding, sourceId: firstSource.id }), 'inactive');
  code(() => approve(denied), 'replay');
  const { authorization } = fixture();
  approve(authorization);
  discover(authorization);
  authorization.revoke();
  code(() => search(authorization, secondQuery), 'inactive');
  code(() => authorization.reserveFetch({ ...binding, sourceId: firstSource.id }), 'inactive');
  authorization.revoke();
  expect(authorization.events().filter((event) => event.type === 'revoked')).toHaveLength(1);
});

test('expiry is checked at approval, each request and settlement, without a background grant', () => {
  const beforeApproval = fixture();
  beforeApproval.clock(1_060_000);
  code(() => approve(beforeApproval.authorization), 'expired');
  const { authorization, clock } = fixture();
  approve(authorization);
  const reservation = search(authorization);
  clock(1_060_000);
  code(() => authorization.recordDiscoveredSources(reservation, [firstSource], 100), 'expired');
  code(() => authorization.reserveFetch({ ...binding, sourceId: firstSource.id }), 'expired');
  code(() => search(authorization, secondQuery), 'expired');
  expect(authorization.usage()).toMatchObject({
    status: 'expired',
    responseBytes: 100,
    reservedResponseBytes: 0,
  });
  expect(authorization.events().filter((event) => event.type === 'expired')).toHaveLength(1);
  expect(authorization.events().at(-1)).toMatchObject({
    type: 'failed',
    kind: 'search',
    responseBytes: 100,
    code: 'expired',
  });
});

test('closing an execution destroys source authority and does not grant a restarted instance', () => {
  const { authorization } = fixture();
  approve(authorization);
  discover(authorization);
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  authorization.validateReservation(fetch, binding);
  authorization.close();
  code(() => search(authorization, secondQuery), 'inactive');
  code(() => authorization.completeFetch(fetch, 20), 'inactive');
  expect(authorization.usage().responseBytes).toBe(120);
  expect(authorization.events().at(-1)).toMatchObject({
    type: 'failed',
    kind: 'fetch',
    responseBytes: 20,
    code: 'inactive',
  });
  authorization.close();
  expect(authorization.events().filter((event) => event.type === 'closed')).toHaveLength(1);
  const restart = fixture().authorization;
  approve(restart);
  code(
    () => restart.reserveFetch({ ...binding, sourceId: firstSource.id }),
    'source-not-discovered',
  );
});

test('audit events are frozen, sequenced and contain no query, URL or web content', () => {
  const { authorization, events } = fixture();
  approve(authorization);
  discover(authorization);
  const fetch = authorization.reserveFetch({ ...binding, sourceId: firstSource.id });
  authorization.validateReservation(fetch, binding);
  authorization.completeFetch(fetch, 25);
  authorization.close();
  expect(events.map((event) => event.type)).toEqual([
    'prepared',
    'decision',
    'reserved',
    'started',
    'completed',
    'reserved',
    'started',
    'completed',
    'closed',
  ]);
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(events.every((event) => Object.isFrozen(event))).toBe(true);
  expect(Object.isFrozen(events[4].sourceIds)).toBe(true);
  expect(JSON.stringify(events)).not.toContain(firstQuery);
  expect(JSON.stringify(events)).not.toContain(firstSource.url);
  expect(Object.isFrozen(authorization.events())).toBe(true);
});

test('audit failure before dispatch fails closed and cannot return a usable reservation', () => {
  const initial = fixture().input;
  const authorization = createResearchAuthorization(initial, {
    now: () => 1_000_000,
    onEvent: (event) => {
      if (event.type === 'reserved') throw new Error('private persistence error');
    },
  });
  approve(authorization);
  code(() => search(authorization), 'audit-failed');
  expect(authorization.usage().status).toBe('revoked');
  code(() => search(authorization, secondQuery), 'inactive');
  expect(JSON.stringify(authorization.events())).not.toContain('private persistence error');
});

test('a regressed or invalid clock fails closed instead of extending the grant', () => {
  const { authorization, clock } = fixture();
  approve(authorization);
  clock(999_999);
  code(() => search(authorization), 'inactive');
  expect(authorization.usage().status).toBe('revoked');
});
