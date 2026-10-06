import { expect, test } from 'bun:test';
import { friendlyError } from './friendly-error';

const fallback = 'Could not save these settings. Check the configuration and try again.';
function ipcError(message: string) {
  return new Error(`Error invoking remote method 'prospero:providers:save': Error: ${message}`);
}

test('credential timeout survives the IPC wrapper as a fixed actionable public message', () => {
  const message =
    'Secure credential operation timed out. Unlock the OS credential store and try again.';
  expect(friendlyError(ipcError(message), fallback)).toBe(message);
  expect(friendlyError(new Error(message), fallback)).toBe(message);
});

test.each([
  'This provider is busy. Wait for its configuration or connection test to finish.',
  'New provider creation is busy. Wait for its secure credential operation to finish.',
  'Wait for Web Search credentials to finish.',
  'Stop the running task or wait for Web Search settings to finish.',
  'Wait for Web Search settings to finish before starting a task.',
  'Unlock secure credential storage and try again.',
])('native reservation busy message remains visible: %s', (message) => {
  expect(friendlyError(ipcError(message), fallback)).toBe(message);
});

test.each([
  'Reopen the window before saving Web Search.',
  'Reopen the window before testing Web Search.',
  'Reopen the window before saving a provider.',
  'Reopen the window before testing a provider.',
  'Reopen the window before starting a task.',
])('shutdown rejection explains the explicit reopen step: %s', (message) => {
  expect(friendlyError(ipcError(message), fallback)).toBe(message);
});

test('endpoint binding failure returns only the fixed re-entry instruction', () => {
  const message =
    'This saved credential does not match its provider endpoint. Re-enter the API key.';
  const error = new Error(`OFFLINE_PRIVATE_KEY provider response: ${message}`);
  expect(friendlyError(error, fallback)).toBe(message);
  expect(friendlyError(error, fallback)).not.toContain('OFFLINE_PRIVATE_KEY');
});

test('unknown private errors and arbitrary UserError names remain generic', () => {
  for (const error of [
    new Error('Authorization: Bearer OFFLINE_PRIVATE_KEY; native provider body'),
    Object.assign(new Error('OFFLINE_PRIVATE_KEY custom user error'), { name: 'UserError' }),
    ipcError('Unexpected credential store failure: OFFLINE_PRIVATE_KEY'),
    new Error('Reopen the window before saving a provider. private body after public text'),
  ]) {
    expect(friendlyError(error, fallback)).toBe(fallback);
    expect(friendlyError(error, fallback)).not.toContain('OFFLINE_PRIVATE_KEY');
  }
});

test('non-Error messages cannot opt into the fixed exception allowlist', () => {
  const message = 'Reopen the window before saving a provider.';
  for (const value of [message, { message, name: 'UserError' }, null, undefined])
    expect(friendlyError(value, fallback)).toBe(fallback);
});
