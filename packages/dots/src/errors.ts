export type DotErrorCode =
  | 'invalid-input'
  | 'invalid-transition'
  | 'invalid-reference'
  | 'run-in-flight';

const MESSAGES: Record<DotErrorCode, string> = {
  'invalid-input': 'The Dot domain input is invalid.',
  'invalid-transition': 'This Dot lifecycle or run transition is not allowed.',
  'invalid-reference': 'The Dot or run reference does not match the current snapshot.',
  'run-in-flight': 'Settle the in-flight run before changing the Dot lifecycle or creating a run.',
};

export class DotError extends Error {
  constructor(public readonly code: DotErrorCode) {
    super(MESSAGES[code]);
    this.name = 'DotError';
  }
}
