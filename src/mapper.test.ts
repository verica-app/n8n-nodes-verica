import { describe, expect, it } from 'vitest';
import {
  buildTracePayload,
  coerceText,
  inferProvider,
  normalizeIntermediateSteps,
  randomHex,
  type TraceFields,
} from './mapper';

const fixedHex = (bytes: number) => 'ab'.repeat(bytes);

const base: TraceFields = {
  input: 'What is the capital of France?',
  output: 'Paris.',
  toolCalls: [{ tool: 'search', toolInput: { query: 'capital of France' } }],
  model: 'gpt-4o',
  provider: '',
  sessionId: 'sess-1',
  inputTokens: 100,
  outputTokens: 20,
  reasoningTokens: 8,
  cachedTokens: 40,
  latencyMs: 1200,
  tags: ['checkout'],
  workflowName: 'My flow',
  executionId: '42',
  nowMs: 1_751_600_000_000,
  randomHex: fixedHex,
};

function attrsOf(body: unknown): Record<string, unknown> {
  const span = (body as any).resourceSpans[0].scopeSpans[0].spans[0];
  return Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value]));
}

describe('buildTracePayload', () => {
  it('emits the gen_ai.* attributes the Verica normalizer accepts', () => {
    const { traceId, body } = buildTracePayload(base);
    expect(traceId).toBe('ab'.repeat(16));
    const span = (body as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.kind).toBe(3);
    expect(span.startTimeUnixNano).toBe(`${base.nowMs - 1200}000000`);
    expect(span.endTimeUnixNano).toBe(`${base.nowMs}000000`);

    const attrs = attrsOf(body);
    expect(attrs['gen_ai.request.model']).toEqual({ stringValue: 'gpt-4o' });
    expect(attrs['gen_ai.provider.name']).toEqual({ stringValue: 'openai' });
    expect(attrs['gen_ai.conversation.id']).toEqual({ stringValue: 'sess-1' });
    expect(attrs['gen_ai.usage.input_tokens']).toEqual({ intValue: '100' });
    expect(attrs['gen_ai.usage.output_tokens']).toEqual({ intValue: '20' });
    expect(attrs['gen_ai.usage.reasoning_tokens']).toEqual({ intValue: '8' });
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toEqual({ intValue: '40' });

    const input = JSON.parse((attrs['gen_ai.input.messages'] as any).stringValue);
    expect(input).toEqual([{ role: 'user', content: 'What is the capital of France?' }]);

    // Chronological: the tool-call-only assistant message, then the answer. base's
    // single tool call has no observation, so no tool message sits between them.
    const output = JSON.parse((attrs['gen_ai.output.messages'] as any).stringValue);
    expect(output).toEqual([
      {
        role: 'assistant',
        tool_calls: [{ function: { name: 'search', arguments: '{"query":"capital of France"}' } }],
      },
      { role: 'assistant', content: 'Paris.' },
    ]);
    expect(output[0].content).toBeUndefined();

    const tags = JSON.parse((attrs['verica.tags'] as any).stringValue);
    expect(tags).toEqual(['n8n:My flow', 'execution:42', 'checkout']);
  });

  it('omits what it does not know: no usage attrs, no end time, no model/provider/session', () => {
    const { body } = buildTracePayload({
      ...base,
      model: '',
      provider: '',
      sessionId: '',
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
      latencyMs: null,
      toolCalls: [],
    });
    const attrs = attrsOf(body);
    expect(attrs['gen_ai.request.model']).toBeUndefined();
    expect(attrs['gen_ai.provider.name']).toBeUndefined();
    expect(attrs['gen_ai.conversation.id']).toBeUndefined();
    expect(attrs['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(attrs['gen_ai.usage.reasoning_tokens']).toBeUndefined();
    expect(attrs['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    const span = (body as any).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.endTimeUnixNano).toBeUndefined();
    const output = JSON.parse((attrs['gen_ai.output.messages'] as any).stringValue);
    expect(output[0].tool_calls).toBeUndefined();
  });

  it('an explicit provider wins over inference', () => {
    const { body } = buildTracePayload({ ...base, provider: 'google', model: 'weird-model' });
    expect(attrsOf(body)['gen_ai.provider.name']).toEqual({ stringValue: 'google' });
  });

  it('emits a chronological call -> result sequence, in order, then the answer', () => {
    const { body } = buildTracePayload({
      ...base,
      output: 'Paris.',
      toolCalls: [
        { tool: 'search', toolInput: { query: 'a' }, observation: 'obs-a' },
        { tool: 'lookup', toolInput: { id: 2 }, observation: 'obs-b' },
      ],
    });
    const output = JSON.parse((attrsOf(body)['gen_ai.output.messages'] as any).stringValue);
    expect(output).toEqual([
      {
        role: 'assistant',
        tool_calls: [{ function: { name: 'search', arguments: '{"query":"a"}' } }],
      },
      { role: 'tool', content: 'obs-a' },
      { role: 'assistant', tool_calls: [{ function: { name: 'lookup', arguments: '{"id":2}' } }] },
      { role: 'tool', content: 'obs-b' },
      { role: 'assistant', content: 'Paris.' },
    ]);
  });

  it('with zero tool calls the output is just the answer message', () => {
    const { body } = buildTracePayload({ ...base, output: 'Paris.', toolCalls: [] });
    const output = JSON.parse((attrsOf(body)['gen_ai.output.messages'] as any).stringValue);
    expect(output).toEqual([{ role: 'assistant', content: 'Paris.' }]);
  });

  it('coerces a non-string observation to text for the tool message', () => {
    const { body } = buildTracePayload({
      ...base,
      output: 'done',
      toolCalls: [{ tool: 'search', toolInput: {}, observation: { text: 'from object' } }],
    });
    const output = JSON.parse((attrsOf(body)['gen_ai.output.messages'] as any).stringValue);
    expect(output).toEqual([
      { role: 'assistant', tool_calls: [{ function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', content: 'from object' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('a tool call WITHOUT an observation emits its assistant message but no tool message', () => {
    const { body } = buildTracePayload({
      ...base,
      output: 'done',
      toolCalls: [{ tool: 'search', toolInput: {} }],
    });
    const output = JSON.parse((attrsOf(body)['gen_ai.output.messages'] as any).stringValue);
    expect(output).toEqual([
      { role: 'assistant', tool_calls: [{ function: { name: 'search', arguments: '{}' } }] },
      { role: 'assistant', content: 'done' },
    ]);
  });
});

describe('inferProvider', () => {
  it('mirrors the Ruby SDK heuristic', () => {
    expect(inferProvider('gemini-2.0-flash')).toBe('google');
    expect(inferProvider('claude-sonnet-5')).toBe('anthropic');
    expect(inferProvider('gpt-4o')).toBe('openai');
    expect(inferProvider('')).toBe('');
  });
});

describe('normalizeIntermediateSteps', () => {
  it('accepts LangChain intermediateSteps ({action:{tool,toolInput}}) and captures the observation', () => {
    expect(
      normalizeIntermediateSteps([
        { action: { tool: 'search', toolInput: { q: 1 } }, observation: 'x' },
      ]),
    ).toEqual([{ tool: 'search', toolInput: { q: 1 }, observation: 'x' }]);
  });

  it('captures no observation for the flat shape (its sibling has no result)', () => {
    expect(normalizeIntermediateSteps([{ tool: 't', toolInput: 'raw' }, 42, null])).toEqual([
      { tool: 't', toolInput: 'raw' },
    ]);
    expect(normalizeIntermediateSteps('nope')).toEqual([]);
  });

  it('accepts a mixed OpenAI Responses output array, ignoring non-tool items', () => {
    expect(
      normalizeIntermediateSteps([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hola', annotations: [] }],
        },
        { type: 'function_call', name: 'search', arguments: '{"q":1}', call_id: 'call_1' },
      ]),
    ).toEqual([{ tool: 'search', toolInput: '{"q":1}' }]);
  });

  it('accepts chat-completions tool_calls ({function:{name,arguments}})', () => {
    expect(normalizeIntermediateSteps([{ function: { name: 'f', arguments: '{}' } }])).toEqual([
      { tool: 'f', toolInput: '{}' },
    ]);
  });
});

describe('coerceText', () => {
  it("flattens the OpenAI 'Message a model' output array to its text", () => {
    const output = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hola', annotations: [] }],
      },
    ];
    expect(coerceText(output)).toBe('Hola');
  });

  it('flattens a chat-completions choices shape to the message content', () => {
    expect(coerceText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  });

  it('passes a plain string through unchanged', () => {
    expect(coerceText('already text')).toBe('already text');
  });

  it('never yields [object Object]: junk objects become their JSON string', () => {
    const junk = { foo: 1, bar: { baz: 2 } };
    const out = coerceText(junk);
    expect(out).not.toContain('[object Object]');
    expect(out).toBe(JSON.stringify(junk));
  });

  it('joins an array of strings with newlines', () => {
    expect(coerceText(['a', 'b', 'c'])).toBe('a\nb\nc');
  });

  it('returns empty string for null/undefined', () => {
    expect(coerceText(null)).toBe('');
    expect(coerceText(undefined)).toBe('');
  });
});

describe('randomHex', () => {
  it('returns lowercase hex of 2 chars per byte', () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });
});
