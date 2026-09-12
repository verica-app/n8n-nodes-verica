import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
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

// n8n's node UX is built on the Resource -> Operation -> Action triad: the
// actions listed on the canvas come from `operation.options[].action`, and a
// node without it is rejected in the manual review (0.2.2 was).
describe('VericaTrace.description', () => {
  const properties = new VericaTrace().description.properties;
  const byName = (name: string) => properties.find((p) => p.name === name);

  it('leads with the Resource and Operation selectors', () => {
    expect(properties[0]?.name).toBe('resource');
    expect(properties[1]?.name).toBe('operation');
  });

  it('marks both selectors as not expression-driven', () => {
    for (const name of ['resource', 'operation']) {
      const param = byName(name);
      expect(param?.type).toBe('options');
      expect(param?.noDataExpression).toBe(true);
      expect(param?.default).toBeTruthy();
    }
  });

  it('gives every operation an action, so it shows up in the actions list', () => {
    const options = (byName('operation')?.options ?? []) as INodePropertyOptions[];
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.action, `operation "${option.value}" has no action`).toBeTruthy();
      expect(option.description).toBeTruthy();
      // Sentence case, no trailing period: `node-param-operation-option-action-miscased`.
      expect(option.action).toMatch(/^[A-Z][^.]*[^.]$/);
    }
  });

  it('exposes System Prompt as a top-level field between Model and Input, optional', () => {
    const names = properties.map((p) => p.name);
    expect(names.indexOf('systemPrompt')).toBe(names.indexOf('model') + 1);
    expect(names.indexOf('input')).toBe(names.indexOf('systemPrompt') + 1);
    const param = byName('systemPrompt');
    expect(param?.type).toBe('string');
    expect(param?.default).toBe('');
    expect(param?.required).toBeFalsy();
    expect(param?.placeholder).toContain("$('AI Agent').params.options.systemMessage");
  });

  it('gates every other field behind the resource and the operation', () => {
    const gated = properties.filter((p) => !['resource', 'operation'].includes(p.name));
    expect(gated.length).toBeGreaterThan(0);
    for (const param of gated as INodeProperties[]) {
      expect(param.displayOptions?.show?.resource, `${param.name} is not gated`).toEqual(['trace']);
      expect(param.displayOptions?.show?.operation, `${param.name} is not gated`).toEqual(['send']);
    }
  });
});

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

  it('sends the system prompt as a leading system message when mapped', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext({
      ...params,
      systemPrompt: 'Answer in French.',
    });
    await new VericaTrace().execute.call(ctx as never);

    const [, req] = httpRequestWithAuthentication.mock.calls[0]!;
    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
    );
    const input = JSON.parse(attrs['gen_ai.input.messages'].stringValue);
    expect(input).toEqual([
      { role: 'system', content: 'Answer in French.' },
      { role: 'user', content: 'capital?' },
    ]);
  });

  it('sends only the user message when the system prompt is left empty', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext(params);
    await new VericaTrace().execute.call(ctx as never);

    const [, req] = httpRequestWithAuthentication.mock.calls[0]!;
    const span = req.body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(
      span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
    );
    const input = JSON.parse(attrs['gen_ai.input.messages'].stringValue);
    expect(input).toEqual([{ role: 'user', content: 'capital?' }]);
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
      options: { ...(params.options as Params), reasoningUsage: 5, cachedUsage: 3 },
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
      options: { ...(params.options as Params), cachedUsage: 0 },
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

  it('fail-open: an unsupported operation annotates the items instead of exporting', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext({
      ...params,
      operation: 'nope',
    });
    const result = await new VericaTrace().execute.call(ctx as never);
    expect(result[0]![0]!.json.vericaError).toContain('nope');
    expect(result[0]![0]!.json.output).toBe('Paris.');
    expect(httpRequestWithAuthentication).not.toHaveBeenCalled();
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
