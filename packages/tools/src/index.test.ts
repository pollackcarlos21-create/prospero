import { describe, expect, test } from 'bun:test';
import { TOOL_DEFINITIONS, TOOL_LIMITS, validateToolArguments } from './index';

describe('tool declarations and strict validation', () => {
  test('every declaration forbids extras and declares its risk', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_directory',
      'get_file_info',
      'search_files',
      'write_file',
      'shell',
      'authorize_research',
      'execute_plan',
      'web_search',
      'fetch_source',
      'fetch_page',
    ]);
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.inputSchema.additionalProperties).toBe(false);
      expect(['read', 'write', 'shell']).toContain(definition.riskLevel);
      expect(definition.effects?.length).toBeGreaterThan(0);
    }
  });

  test.each([
    ['unknown', '{}'],
    ['read_file', '{'],
    ['read_file', 'null'],
    ['read_file', '[]'],
    ['read_file', '{}'],
    ['read_file', '{"path":4}'],
    ['read_file', '{"path":""}'],
    ['read_file', '{"path":"a","maxBytes":0}'],
    ['read_file', '{"path":"a","maxBytes":1.2}'],
    ['read_file', '{"path":"a","maxBytes":true}'],
    ['read_file', '{"path":"a","__proto__":{}}'],
    ['write_file', '{"path":"a","content":"x","force":true}'],
    ['shell', '{"command":"pwd","cwd":"/"}'],
    ['shell', '{"command":"pwd","timeoutMs":99}'],
    ['shell', '{"command":"pwd","timeoutMs":120001}'],
    ['search_files', '{"pattern":""}'],
    ['list_directory', '{"maxEntries":501}'],
    ['list_directory', '{"cursor":""}'],
    ['list_directory', '{"cursor":"bad cursor"}'],
    ['get_file_info', '{}'],
    ['get_file_info', '{"path":"x","followSymlinks":true}'],
  ])('rejects invalid %s arguments %s', (name, args) => {
    expect(() => validateToolArguments(name, args)).toThrow();
  });

  test('enforces UTF-8 content bytes and NUL bounds', () => {
    expect(() =>
      validateToolArguments(
        'write_file',
        JSON.stringify({ path: 'a', content: '中'.repeat(TOOL_LIMITS.fileBytes / 2) }),
      ),
    ).toThrow('size');
    expect(() => validateToolArguments('read_file', JSON.stringify({ path: 'a\0b' }))).toThrow(
      'string',
    );
    expect(() =>
      validateToolArguments(
        'shell',
        JSON.stringify({ command: 'x'.repeat(TOOL_LIMITS.maxCommandLength + 1) }),
      ),
    ).toThrow('string');
  });

  test('accepts empty writes and bounded optional arguments', () => {
    expect(validateToolArguments('write_file', '{"path":"a","content":""}')).toEqual({
      path: 'a',
      content: '',
    });
    expect(validateToolArguments('search_files', '{"pattern":".*","maxResults":1}')).toEqual({
      pattern: '.*',
      maxResults: 1,
    });
  });

  test('nested action references are strict and action counts/content are bounded', () => {
    const valid = {
      title: 'Organize notes',
      actions: [
        {
          kind: 'copy_file',
          source: { scopeId: 'read', path: 'notes.pdf' },
          target: { scopeId: 'write', path: 'notes.pdf' },
        },
      ],
    };
    expect(validateToolArguments('execute_plan', JSON.stringify(valid))).toEqual(valid);
    for (const actions of [
      [],
      [...Array(26)].map(() => valid.actions[0]),
      [{ ...valid.actions[0], force: true }],
      [{ ...valid.actions[0], source: { ...valid.actions[0].source, bypass: true } }],
      [{ kind: 'shell', command: 'rm x' }],
    ])
      expect(() =>
        validateToolArguments('execute_plan', JSON.stringify({ title: 'x', actions })),
      ).toThrow();
    expect(() =>
      validateToolArguments(
        'execute_plan',
        JSON.stringify({
          title: 'x',
          actions: [
            {
              kind: 'write_text',
              target: { scopeId: 'write', path: 'x' },
              content: '中'.repeat(TOOL_LIMITS.fileBytes / 2),
            },
          ],
        }),
      ),
    ).toThrow('size');
  });
  test('network declarations do not accept arbitrary credentials, headers or search overrides', () => {
    expect(() =>
      validateToolArguments(
        'fetch_page',
        JSON.stringify({ url: 'https://example.org', headers: { Authorization: 'secret' } }),
      ),
    ).toThrow();
    expect(() =>
      validateToolArguments(
        'web_search',
        JSON.stringify({ query: 'x', endpoint: 'https://other.example' }),
      ),
    ).toThrow();
    expect(() =>
      validateToolArguments('web_search', JSON.stringify({ query: Array(76).fill('x').join(' ') })),
    ).toThrow();
  });
  test('research proposal and source ID schemas reject invented authority and expanded limits', () => {
    const valid = {
      title: 'Study',
      queries: [{ query: 'paper', maxResults: 2 }],
      maxFetches: 1,
      maxResponseBytes: 1024,
      lifetimeSeconds: 60,
    };
    expect(validateToolArguments('authorize_research', JSON.stringify(valid))).toEqual(valid);
    for (const args of [
      { ...valid, digest: 'forged' },
      { ...valid, executionId: 'forged' },
      { ...valid, approved: true },
      { ...valid, maxFetches: 25 },
      { ...valid, maxResponseBytes: 16 * 1024 * 1024 + 1 },
      { ...valid, lifetimeSeconds: 901 },
      {
        ...valid,
        queries: [{ query: 'paper', maxResults: 2, endpoint: 'https://attacker.example.org' }],
      },
    ])
      expect(() => validateToolArguments('authorize_research', JSON.stringify(args))).toThrow();
    for (const args of [
      { sourceId: 'src_invalid' },
      { sourceId: `src_${'Z'.repeat(24)}` },
      { sourceId: `src_${'a'.repeat(24)}`, url: 'https://attacker.example.org' },
    ])
      expect(() => validateToolArguments('fetch_source', JSON.stringify(args))).toThrow();
  });
});
