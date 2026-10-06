import { createServer, type ServerResponse } from 'node:http';
export interface CapturedRequest {
  messages: { role: string; content: string; tool_call_id?: string }[];
  tools?: unknown[];
  model: string;
}
export type FakeResponse = { text: string } | { tool: string; args: unknown };
export async function startFakeProvider(
  respond?: (
    request: CapturedRequest,
    task: string,
    results: CapturedRequest['messages'],
  ) => FakeResponse | undefined,
) {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let abortedStreams = 0;
  let expectedCredential: string | undefined;
  function chunk(response: ServerResponse, value: unknown) {
    response.write(`data: ${JSON.stringify(value)}\n\n`);
  }
  function textResponse(response: ServerResponse, text: string) {
    chunk(response, {
      choices: [
        { index: 0, delta: { role: 'assistant', content: text.slice(0, 12) }, finish_reason: null },
      ],
    });
    setTimeout(() => {
      chunk(response, {
        choices: [{ index: 0, delta: { content: text.slice(12) }, finish_reason: null }],
      });
      chunk(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      response.end('data: [DONE]\n\n');
    }, 70);
  }
  function tool(response: ServerResponse, name: string, args: unknown) {
    const argumentsText = JSON.stringify(args);
    chunk(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: { name, arguments: argumentsText.slice(0, 5) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunk(response, {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(5) } }] },
          finish_reason: null,
        },
      ],
    });
    chunk(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    response.end('data: [DONE]\n\n');
  }
  const server = createServer(async (request, response) => {
    if (expectedCredential && request.headers.authorization !== `Bearer ${expectedCredential}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'offline-model' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const input = JSON.parse(body) as CapturedRequest;
    requests.push(input);
    const lastUser = input.messages.findLastIndex(
      (message) => message.role === 'user' && !message.content.startsWith('Saved preference data'),
    );
    const task = input.messages[lastUser]?.content ?? '';
    const results = input.messages.slice(lastUser + 1).filter((message) => message.role === 'tool');
    if (task.includes('provider error')) {
      response
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ private: 'never expose private provider body' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const custom = respond?.(input, task, results);
    if (custom) {
      if ('text' in custom) textResponse(response, custom.text);
      else tool(response, custom.tool, custom.args);
      return;
    }
    if (task.includes('notification long completion')) {
      chunk(response, {
        choices: [
          {
            index: 0,
            delta: { content: 'Working on the notification test. ' },
            finish_reason: null,
          },
        ],
      });
      // Actual elapsed time exercises the desktop host's >=10s gate; no fake clock.
      const completion = setTimeout(() => {
        chunk(response, {
          choices: [{ index: 0, delta: { content: 'Long task complete.' }, finish_reason: null }],
        });
        chunk(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        response.end('data: [DONE]\n\n');
      }, 11_000);
      response.once('close', () => clearTimeout(completion));
      return;
    }
    if (task.includes('slow model')) {
      chunk(response, {
        choices: [
          {
            index: 0,
            delta: { content: 'A partial response that survives stopping.' },
            finish_reason: null,
          },
        ],
      });
      const keepalive = setInterval(() => response.write(': keepalive\n\n'), 500);
      response.on('close', () => {
        clearInterval(keepalive);
        abortedStreams++;
      });
      return;
    }
    if (task.includes('slow shell')) {
      if (!results.length)
        tool(response, 'shell', { command: 'echo $$ > child.pid; sleep 60', timeoutMs: 90_000 });
      else textResponse(response, 'Shell returned.');
      return;
    }
    if (task.includes('deny shell')) {
      if (!results.length)
        tool(response, 'shell', { command: "printf 'should-not-run' > denied.txt" });
      else textResponse(response, 'The command was denied and no changes were made.');
      return;
    }
    if (task.includes('read confirmation')) {
      if (!results.length) tool(response, 'read_file', { path: 'notes.txt' });
      else textResponse(response, 'Read complete with permission.');
      return;
    }
    if (task.includes('offline agent')) {
      if (!results.length) tool(response, 'read_file', { path: 'notes.txt' });
      else if (results.length === 1) tool(response, 'shell', { command: "printf 'shell-ok'" });
      else if (results.length === 2)
        tool(response, 'write_file', {
          path: 'result.txt',
          content: 'Prospero saved this after approval.\n',
        });
      else
        textResponse(response, 'Your notes were read, shell succeeded, and result.txt was saved.');
      return;
    }
    textResponse(response, 'Offline conversation complete.');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake provider did not listen');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    expectCredential: (credential: string) => {
      expectedCredential = credential;
    },
    get abortedStreams() {
      return abortedStreams;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
