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

  it("coerces the OpenAI 'Message a model' output array to text, not [object Object]", async () => {
    const messageAModelOutput = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hola', annotations: [] }],
      },
    ];
    // No tool calls here, so the answer is the sole output message: index 0.
    const { ctx, httpRequestWithAuthentication } = makeContext({
      ...params,
      toolCalls: [],
      output: messageAModelOutput,
    });
    await new VericaTrace().execute.call(ctx as never);

    const [, req] = httpRequestWithAuthentication.mock.calls[0]!;
    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
    );
    const output = JSON.parse(attrs['gen_ai.output.messages'].stringValue);
    expect(output[0].content).toBe('Hola');
    expect(output[0].content).not.toContain('[object Object]');
  });

  it('picks tool calls out of a mixed OpenAI Responses output array', async () => {
    const responsesOutput = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hola', annotations: [] }],
      },
      { type: 'function_call', name: 'search', arguments: '{"q":1}', call_id: 'call_1' },
    ];
    const { ctx, httpRequestWithAuthentication } = makeContext({
      ...params,
      toolCalls: responsesOutput,
    });
    await new VericaTrace().execute.call(ctx as never);

    const [, req] = httpRequestWithAuthentication.mock.calls[0]!;
    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
    );
    const output = JSON.parse(attrs['gen_ai.output.messages'].stringValue);
    expect(output[0].tool_calls).toEqual([{ function: { name: 'search', arguments: '{"q":1}' } }]);
  });

  it('emits reasoning and cached token attrs when the options are set', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext({
      ...params,
      options: { ...(params.options as Params), reasoningTokens: 5, cachedTokens: 3 },
    });
    await new VericaTrace().execute.call(ctx as never);

    const [, req] = httpRequestWithAuthentication.mock.calls[0]!;
    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
    );
    expect(attrs['gen_ai.usage.reasoning_tokens']).toEqual({ intValue: '5' });
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toEqual({ intValue: '3' });
  });

  it('preserves a cached-tokens value of 0 (a valid breakdown, not "missing")', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext({
      ...params,
      options: { ...(params.options as Params), cachedTokens: 0 },
    });
    await new VericaTrace().execute.call(ctx as never);

    const [, req] = httpRequestWithAuthentication.mock.calls[0]!;
    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
    );
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toEqual({ intValue: '0' });
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
