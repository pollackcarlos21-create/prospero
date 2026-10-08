export type DotRepositoryErrorCode =
  | 'not-found'
  | 'duplicate-id'
  | 'conflict'
  | 'invalid-stored-state'
  | 'storage-failure';

const MESSAGES: Record<DotRepositoryErrorCode, string> = {
  'not-found': 'The requested Dot or run was not found.',
  'duplicate-id': 'The Dot or run identity already exists.',
  conflict: 'The Dot revision has changed. Read the current state before continuing.',
  'invalid-stored-state': 'The stored Dot or run state is invalid.',
  'storage-failure': 'The Dot repository operation could not be committed or read.',
};

export class DotRepositoryError extends Error {
  constructor(public readonly code: DotRepositoryErrorCode) {
    super(MESSAGES[code]);
    this.name = 'DotRepositoryError';
  }
}
