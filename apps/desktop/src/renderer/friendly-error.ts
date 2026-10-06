// Only these fixed, public messages may be recovered from an IPC exception.
// Never render an arbitrary exception or provider response body.
const publicMessages = [
  'Finish or stop the running task before starting another.',
  'Stop the active task first.',
  'Stop tasks using this provider before editing.',
  'Stop tasks using this provider before deleting.',
  'Re-enter the API key when changing its endpoint.',
  'Re-enter the API key before testing a different endpoint.',
  'Add a model provider in Settings before sending a task.',
  'Provider not found.',
  'Conversation not found.',
  'Choose a folder.',
  'A secure OS credential store is required.',
  'Unlock secure credential storage and try again.',
  'The OS credential store is unavailable. Unlock it and try again.',
  'Secure credential operation timed out. Unlock the OS credential store and try again.',
  'This provider is busy. Wait for its configuration or connection test to finish.',
  'New provider creation is busy. Wait for its secure credential operation to finish.',
  'Wait for Web Search credentials to finish.',
  'Stop the running task or wait for Web Search settings to finish.',
  'Wait for Web Search settings to finish before starting a task.',
  'Reopen the window before saving Web Search.',
  'Reopen the window before testing Web Search.',
  'Reopen the window before saving a provider.',
  'Reopen the window before testing a provider.',
  'Reopen the window before starting a task.',
  'This saved credential does not match its provider endpoint. Re-enter the API key.',
];
export function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return publicMessages.find((message) => error.message.endsWith(message)) ?? fallback;
}
