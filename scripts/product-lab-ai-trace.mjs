// Node --import preload. Observe actual model requests without storing credentials or headers.
import { appendFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
const output = process.env.CONCLAVE_LAB_TRACE;
if (output) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!/\/(chat\/completions|messages)$/u.test(url.pathname)) return originalFetch(input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const id = crypto.randomUUID();
    const started = performance.now();
    const record = (event) => appendFileSync(output, JSON.stringify({ id, ...event }) + '\n');
    record({ event: 'started', requestedModel: body.model, role: /You are the (\w+)/u.exec(body.messages?.[0]?.content ?? body.system ?? '')?.[1]?.toLowerCase() ?? null });
    try {
      const response = await originalFetch(input, init);
      let payload;
      try { payload = await response.clone().json(); } catch { payload = {}; }
      record({ event: 'finished', status: response.status, returnedModel: payload.model ?? null, usage: payload.usage ?? null, durationMs: performance.now() - started });
      return response;
    } catch (error) {
      record({ event: 'failed', errorType: error.name, durationMs: performance.now() - started });
      throw error;
    }
  };
}
