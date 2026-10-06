import { lookup } from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { WebError } from './errors';
import type {
  WebAddress,
  WebResolver,
  WebTransport,
  WebTransportRequest,
  WebTransportResponse,
} from './types';

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedV4.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], // IETF protocol assignments, including Teredo, benchmarks and ORCHID.
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 can embed otherwise blocked IPv4 addresses.
  ['3fff::', 20], // IPv6 documentation space.
] as const)
  blockedV6.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

function plainHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/** Syntax and literal-IP validation only. DNS validation happens before every connection. */
export function canonicalPublicUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    [...value].some((letter) => letter.charCodeAt(0) <= 32 || letter.charCodeAt(0) === 127)
  )
    throw new WebError('blocked-url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebError('blocked-url');
  }
  const hostname = plainHostname(url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hostname ||
    hostname === 'localhost' ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|onion)$/.test(hostname) ||
    (!isIP(hostname) && !hostname.includes('.')) ||
    (isIP(hostname) !== 0 && !isPublicAddress(hostname))
  )
    throw new WebError('blocked-url');
  if (!isIP(hostname)) url.hostname = hostname;
  url.hash = '';
  return url.href;
}

export const systemResolver: WebResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((item) => ({
    address: item.address,
    family: item.family as 4 | 6,
  }));

export async function resolvePublicAddress(url: URL, resolver: WebResolver): Promise<WebAddress> {
  const hostname = plainHostname(url);
  const literalFamily = isIP(hostname);
  const addresses: readonly WebAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname);
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.length > 32 ||
    addresses.some(
      (item) =>
        !item ||
        isIP(item.address) !== item.family ||
        ![4, 6].includes(item.family) ||
        !isPublicAddress(item.address),
    )
  )
    throw new WebError('blocked-address');
  return Object.freeze({ ...addresses[0] });
}

function sameAddress(actual: string, expected: WebAddress): boolean {
  if (expected.family === 4) return actual.replace(/^::ffff:/, '') === expected.address;
  if (isIP(actual) !== 6) return false;
  const singleAddress = new BlockList();
  singleAddress.addAddress(expected.address, 'ipv6');
  return singleAddress.check(actual, 'ipv6');
}

type RequestFactory = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/** Internal injectable request factory permits checking real connection options offline. */
export function createPinnedHttpsTransport(factory: RequestFactory = httpsRequest): WebTransport {
  return async (input) =>
    new Promise<WebTransportResponse>((resolve, reject) => {
      if (input.signal.aborted) return reject(new WebError('cancelled'));
      const method = input.method ?? 'GET';
      if (
        !['GET', 'POST'].includes(method) ||
        (method === 'GET' && input.body !== undefined) ||
        (method === 'POST' &&
          (!(input.body instanceof Uint8Array) ||
            input.body.byteLength === 0 ||
            input.body.byteLength > 16 * 1024))
      )
        return reject(new WebError('invalid-input'));
      const body = input.body === undefined ? undefined : Buffer.from(input.body);
      let settled = false;
      let response: IncomingMessage | undefined;
      let client: ClientRequest;
      const cleanup = () => input.signal.removeEventListener('abort', abort);
      const fail = (error: WebError) => {
        if (settled) return;
        settled = true;
        cleanup();
        response?.destroy();
        client?.destroy();
        reject(error);
      };
      const abort = () => fail(new WebError('cancelled'));
      const hostname = plainHostname(input.url);
      const options: RequestOptions & { autoSelectFamily: boolean } = {
        protocol: 'https:',
        hostname,
        port: 443,
        method,
        path: `${input.url.pathname}${input.url.search}`,
        headers: { ...input.headers },
        agent: false,
        rejectUnauthorized: true,
        family: input.address.family,
        autoSelectFamily: false,
        maxHeaderSize: 16 * 1024,
        ...(isIP(hostname) ? {} : { servername: hostname }),
        lookup: (_hostname, _options, callback) =>
          callback(null, input.address.address, input.address.family),
      };
      try {
        client = factory(options, (incoming) => {
          response = incoming;
          if (settled) return incoming.destroy();
          const headers: Record<string, string | undefined> = {};
          for (const key of ['content-type', 'content-length', 'content-encoding', 'location']) {
            const value = incoming.headers[key];
            if (Array.isArray(value)) return fail(new WebError('incompatible'));
            headers[key] = value;
          }
          const encoding = headers['content-encoding'];
          if (encoding && encoding.toLowerCase() !== 'identity')
            return fail(new WebError('unsupported-content'));
          const size = headers['content-length'];
          if (size && (!/^\d+$/.test(size) || Number(size) > input.maxBytes))
            return fail(new WebError('too-large'));
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on('data', (data: Buffer) => {
            if (settled) return;
            bytes += data.length;
            if (bytes > input.maxBytes) return fail(new WebError('too-large'));
            chunks.push(data);
          });
          incoming.once('aborted', () => fail(new WebError('network')));
          incoming.once('error', () => fail(new WebError('network')));
          incoming.once('end', () => {
            if (settled) return;
            if (input.signal.aborted) return fail(new WebError('cancelled'));
            settled = true;
            cleanup();
            resolve({ status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        });
        client.once('socket', (socket: TLSSocket) => {
          socket.once('secureConnect', () => {
            if (!socket.remoteAddress || !sameAddress(socket.remoteAddress, input.address))
              fail(new WebError('blocked-address'));
          });
        });
        client.once('error', () => fail(new WebError('network')));
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) return abort();
        client.end(body);
      } catch {
        fail(new WebError('network'));
      }
    });
}

export const pinnedHttpsTransport = createPinnedHttpsTransport();

export function validateTransportBody(
  response: WebTransportResponse,
  input: Pick<WebTransportRequest, 'maxBytes'>,
): void {
  if (!(response.body instanceof Uint8Array) || response.body.byteLength > input.maxBytes)
    throw new WebError('too-large');
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
    throw new WebError('incompatible');
  const encoding = response.headers['content-encoding'];
  if (encoding && encoding.toLowerCase() !== 'identity') throw new WebError('unsupported-content');
  const length = response.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > input.maxBytes))
    throw new WebError('too-large');
}
