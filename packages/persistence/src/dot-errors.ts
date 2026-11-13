export type DotRepositoryErrorCode =
  | 'not-found'
  | 'duplicate-id'
  | 'conflict'
  | 'ownership-required'
  | 'invalid-intent'
  | 'intent-blocked'
  | 'policy-blocked'
  | 'wake-blocked'
  | 'invalid-stored-state'
  | 'storage-failure';

const MESSAGES: Record<DotRepositoryErrorCode, string> = {
  'wake-blocked':
    'This Dot wake needs an active research authorization, an available budget and a time before authorization expires.',
  'not-found': 'The requested Dot or run was not found.',
  'duplicate-id': 'The Dot or run identity already exists.',
  conflict: 'The Dot revision has changed. Read the current state before continuing.',
  'ownership-required': 'Exclusive profile ownership is required for Dot startup recovery.',
  'invalid-intent': 'The Dot approval intent is invalid or does not match its saved continuation.',
  'intent-blocked': 'Inspect or resolve the existing Dot approval before continuing.',
  'policy-blocked':
    'This Dot research authorization is inactive, changed, expired or has reached its budget. Review it before continuing.',
  'invalid-stored-state': 'The stored Dot or run state is invalid.',
  'storage-failure': 'The Dot repository operation could not be committed or read.',
};

export class DotRepositoryError extends Error {
  constructor(public readonly code: DotRepositoryErrorCode) {
    super(MESSAGES[code]);
    this.name = 'DotRepositoryError';
  }
}
