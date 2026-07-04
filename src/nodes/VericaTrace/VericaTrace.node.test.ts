import { describe, expect, it, vi } from 'vitest';
import { VericaTrace } from './VericaTrace.node';

type Params = Record<string, unknown>;

function makeContext(params: Params, opts?: { reject?: boolean }) {
  const httpRequestWithAuthentication = opts?.reject
    ? vi.fn().mockRejectedValue(new Error('boom'))
    : vi.fn().mockResolvedValue({ partialSuccess: {} });
  const ctx = {
    getInputData: () => [{ json: { output: 'Paris.', chatInput: 'capital?', sessionId: 's1' } }],
    getNodeParameter: (name: string, _i: number, fallback: unknown) => params[name] ?? fallback,
    getCredentials: vi
      .fn()
      .mockResolvedValue({ token: 'tok', endpoint: 'https://ingest.verica.app/' }),
    getWorkflow: () => ({ name: 'My flow' }),
    getExecutionId: () => '42',
    helpers: { httpRequestWithAuthentication },
  };
  return { ctx, httpRequestWithAuthentication };
}

const params: Params = {
  model: 'gpt-4o',
  input: 'capital?',
  output: 'Paris.',
  toolCalls: [{ action: { tool: 'search', toolInput: { q: 'x' } } }],
  options: { sessionId: 's1', tags: 'checkout, prod' },
};

describe('VericaTrace.execute', () => {
  it('POSTs the OTLP payload with the n8n source header and passes items through', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext(params);
    const result = await new VericaTrace().execute.call(ctx as never);

    expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1);
    const [credName, req] = httpRequestWithAuthentication.mock.calls[0]!;
    expect(credName).toBe('vericaApi');
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://ingest.verica.app/v1/traces');
    expect(req.headers['x-verica-source']).toBe('n8n');
    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    const keys = span.attributes.map((a: { key: string }) => a.key);
    expect(keys).toContain('gen_ai.input.messages');
    expect(keys).toContain('verica.tags');

    expect(result[0]![0]!.json.output).toBe('Paris.'); // passthrough
    expect(result[0]![0]!.json.vericaTraceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('fail-open: an export error never throws, it annotates the item', async () => {
    const { ctx } = makeContext(params, { reject: true });
    const result = await new VericaTrace().execute.call(ctx as never);
    expect(result[0]![0]!.json.vericaError).toBe('boom');
    expect(result[0]![0]!.json.output).toBe('Paris.');
  });

  it('fail-open: a credential-resolution error never throws, it annotates the items', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext(params);
    ctx.getCredentials = vi.fn().mockRejectedValue(new Error('cred boom'));
    const result = await new VericaTrace().execute.call(ctx as never);
    expect(result[0]![0]!.json.vericaError).toBe('cred boom');
    expect(result[0]![0]!.json.output).toBe('Paris.');
    expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
  });
});
