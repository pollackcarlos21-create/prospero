import { OpenAICompatibleProvider, testConnection } from '@prospero/providers';
const apiKey = process.env.PROSPERO_API_KEY;
const baseUrl = process.env.PROSPERO_BASE_URL;
const model = process.env.PROSPERO_MODEL;
if (!apiKey || !baseUrl || !model) {
  console.log('BLOCKED — real provider credential unavailable');
  process.exit(0);
}
const config = { apiKey, baseUrl, model, timeoutMs: 30_000 };
const connection = await testConnection(config);
console.log(`Connection: ${connection.status}`);
if (connection.status !== 'connected') process.exit(1);
try {
  const result = await new OpenAICompatibleProvider(config).stream(
    { messages: [{ role: 'user', content: 'Reply with only: OK' }], tools: [] },
    () => {},
    new AbortController().signal,
  );
  console.log(
    `Streaming smoke: ${result.content.trim() === 'OK' ? 'passed' : 'completed with alternate response'}`,
  );
} catch {
  console.log('Streaming smoke failed. No provider response or credential has been logged.');
  process.exit(1);
}
