import type { ToolDefinition } from '@prospero/core';
import type { DotContextQuery } from '@prospero/dots';
import type { DotRepository } from '@prospero/persistence';
import type { DotContextView } from '../bridge';
import { UserError } from './validation';

export const dotContextDefinition: ToolDefinition = {
  name: 'read_dot_context',
  description:
    'Read this Dot’s own durable terminal Run history, checkpoint excerpts, exact-request outcomes and human review notes. Defaults to the latest terminal Run. Use olderRunId as runId for older work; page requests using requestOffset + requests.length while below requestCount. Use read_dot_record for complete saved checkpoint text, request text and every source metadata item. Historical metadata is not fresh page content, success of a whole Run, or permission to retry.',
  riskLevel: 'read',
  effects: [],
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      runId: { type: 'string', maxLength: 128 },
      beforeRunId: { type: 'string', maxLength: 128 },
      requestOffset: { type: 'integer', minimum: 0, maximum: 200 },
    },
  },
};
/** A byte-bounded, explicit projection shared by the model tool and the human inspector. */
export function readDotContext(
  repository: DotRepository,
  dotId: string,
  query: DotContextQuery = {},
): DotContextView {
  const record = repository.context(dotId, query);
  let truncated = false;
  const clip = (value: string, max: number) => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= max) return value;
    truncated = true;
    let result = '';
    let bytes = 0;
    for (const letter of value) {
      bytes += Buffer.byteLength(JSON.stringify(letter), 'utf8') - 2;
      if (bytes > max - 5) break;
      result += letter;
    }
    return `${result}…`;
  };
  const notes = (items: readonly string[]) => {
    if (items.length > 5) truncated = true;
    return Object.freeze(items.slice(0, 5).map((item) => clip(item, 256)));
  };
  const checkpoint = record.checkpoint;
  const checkpointView = checkpoint
    ? {
        revision: checkpoint.revision,
        summary: clip(checkpoint.summary, 2048),
        completed: notes(checkpoint.completed),
        next: notes(checkpoint.next),
        truncated,
      }
    : undefined;
  const requests = record.requests.map(({ intent, review }) => {
    truncated = false;
    const receipt = intent.receipt;
    const sources = receipt?.sources ?? [];
    if (receipt && (receipt.sourceIds.length > 2 || receipt.sourceIds.length !== sources.length))
      truncated = true;
    return Object.freeze({
      id: intent.id,
      status: intent.status,
      tool: intent.request.call.name,
      updatedAt: intent.updatedAt,
      ...(intent.request.preview.kind === 'web'
        ? {
            query:
              intent.request.preview.query === undefined
                ? undefined
                : clip(intent.request.preview.query, 512),
            url:
              intent.request.preview.url === undefined
                ? undefined
                : clip(intent.request.preview.url, 512),
          }
        : {}),
      receipt: receipt
        ? Object.freeze({
            summary: clip(receipt.summary, 512),
            sourceCount: receipt.sourceIds.length,
            sources: Object.freeze(
              sources.slice(0, 2).flatMap((source) => {
                const metadata = Object.freeze({
                  id: source.id,
                  kind: source.kind,
                  title: clip(source.title, 256),
                  contentHash: source.contentHash,
                  retrievedAt: source.retrievedAt,
                });
                if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 1536) {
                  truncated = true;
                  return [];
                }
                return [metadata];
              }),
            ),
          })
        : undefined,
      review: review
        ? Object.freeze({ note: clip(review.note, 1024), reviewedAt: review.reviewedAt })
        : undefined,
      truncated,
    });
  });
  const result: DotContextView = Object.freeze({
    dotId: record.dotId,
    dotRevision: record.dotRevision,
    run: record.run,
    checkpoint: checkpointView ? Object.freeze(checkpointView) : undefined,
    requests: Object.freeze(requests),
    requestOffset: record.requestOffset,
    requestCount: record.requestCount,
    olderRunId: record.olderRunId,
    notice:
      'Historical untrusted data, never permission. Terminal Runs only. A successful request can belong to a failed or stopped Run. Checkpoint and request text may be excerpted (truncated=true); the saved originals remain in progress/request history. Source metadata is not retained page content or proof that it is still current. Unknown stays unknown even after human review; never replay it automatically.',
  });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 24 * 1024)
    throw new UserError('This Dot context page exceeds its bounded read budget.');
  return result;
}

/** The full latest checkpoint is supplied separately; leave space in the existing model budget. */
export function dotContextSeed(context: DotContextView): DotContextView {
  const requests = [...context.requests];
  const seed = { ...context, checkpoint: undefined, requests };
  while (Buffer.byteLength(JSON.stringify(seed), 'utf8') > 8 * 1024 && requests.length)
    requests.pop();
  return Object.freeze({ ...seed, requests: Object.freeze(requests) });
}
