import { expect, test } from 'bun:test';
import { validateCitationMarkers } from '../acceptance/web-cases';

const first = `src_${'1'.repeat(24)}`;
const second = `src_${'2'.repeat(24)}`;
const registered = [{ id: first }, { id: second }];
const baseline = `Observed supported conclusion [source:${first}] and limitation [source:${second}].`;

test('acceptance citation oracle resolves every actual source marker, including repeated citations', () => {
  expect(validateCitationMarkers(`${baseline} Repeated [source:${first}].`, registered)).toEqual([
    first,
    second,
    first,
  ]);
});

test('an additional invalid citation cannot hide behind otherwise valid source evidence', () => {
  expect(validateCitationMarkers(baseline, registered)).toEqual([first, second]);
  for (const mutation of [
    '[source:forged]',
    `[source:src_${'3'.repeat(24)}]`,
    '[source:]',
    `[source: ${first}]`,
    `[source:${first.toUpperCase()}]`,
    `[Source:${first}]`,
    `[source:${first}\n]`,
    `[source:${first.slice(0, -1)}]`,
    `[source:${first}`,
    `[source:[source:${first}]]`,
  ]) {
    expect(() => validateCitationMarkers(`${baseline} ${mutation}`, registered)).toThrow();
  }
});

test('missing evidence and an entirely unregistered citation fail the research oracle', () => {
  expect(() => validateCitationMarkers('A research claim with no source.', registered)).toThrow();
  expect(() => validateCitationMarkers(`[source:${first}]`, [])).toThrow();
});
