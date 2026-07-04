// Pure OTLP payload builder. NO imports, NO env, NO fs: this file must stay
// dependency-free so the package passes n8n community-node verification, and
// deterministic (time and randomness are injected) so it is unit-testable.
// It emits exactly the gen_ai.* attributes Verica's ingest normalizer accepts
// (semconv-pinned) with OpenAI-style messages, so tool_check and previews work.

export interface ToolCallInput {
  tool: string;
  toolInput: unknown;
}

export interface TraceFields {
  input: string;
  output: string;
  toolCalls: ToolCallInput[];
  model: string;
  /** '' = infer from the model name. */
  provider: string;
  sessionId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  tags: string[];
  workflowName: string;
  executionId: string;
  nowMs: number;
  randomHex: (bytes: number) => string;
}

type OtlpAttr = { key: string; value: { stringValue: string } | { intValue: string } };

const MAX_TAGS = 20;
const MAX_TAG_LEN = 120;

/** Trace ids are correlation ids, not secrets: Math.random is fine (and dep-free). */
export function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes * 2; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** Mirror of the Ruby SDK's Verica::Providers.for_model heuristic. */
export function inferProvider(model: string): string {
  if (model.length === 0) return '';
  const m = model.toLowerCase();
  if (m.startsWith('gemini')) return 'google';
  if (m.includes('claude')) return 'anthropic';
  return 'openai';
}

/** LangChain intermediateSteps ({action:{tool,toolInput}}) or flat {tool,toolInput}. */
export function normalizeIntermediateSteps(raw: unknown): ToolCallInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCallInput[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const action =
      rec.action != null && typeof rec.action === 'object'
        ? (rec.action as Record<string, unknown>)
        : rec;
    if (typeof action.tool !== 'string' || action.tool.length === 0) continue;
    out.push({ tool: action.tool, toolInput: action.toolInput });
  }
  return out;
}

export function buildTracePayload(f: TraceFields): { traceId: string; body: unknown } {
  const traceId = f.randomHex(16);
  const spanId = f.randomHex(8);
  const startMs = f.nowMs - (f.latencyMs ?? 0);

  const s = (key: string, v: string): OtlpAttr => ({ key, value: { stringValue: v } });
  const i = (key: string, v: number): OtlpAttr => ({ key, value: { intValue: String(v) } });

  const provider = f.provider.length > 0 ? f.provider : inferProvider(f.model);
  const toolCalls = f.toolCalls.map((c) => ({
    function: {
      name: c.tool,
      arguments: typeof c.toolInput === 'string' ? c.toolInput : JSON.stringify(c.toolInput ?? {}),
    },
  }));
  const outputMessage: Record<string, unknown> = { role: 'assistant', content: f.output };
  if (toolCalls.length > 0) outputMessage.tool_calls = toolCalls;

  const tags = [
    `n8n:${f.workflowName}`,
    ...(f.executionId ? [`execution:${f.executionId}`] : []),
    ...f.tags,
  ]
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_TAGS)
    .map((t) => (t.length <= MAX_TAG_LEN ? t : t.slice(0, MAX_TAG_LEN)));

  const attributes: OtlpAttr[] = [
    s('gen_ai.input.messages', JSON.stringify([{ role: 'user', content: f.input }])),
    s('gen_ai.output.messages', JSON.stringify([outputMessage])),
    s('verica.tags', JSON.stringify(tags)),
  ];
  if (f.model.length > 0) attributes.push(s('gen_ai.request.model', f.model));
  if (provider.length > 0) attributes.push(s('gen_ai.provider.name', provider));
  if (f.sessionId.length > 0) attributes.push(s('gen_ai.conversation.id', f.sessionId));
  if (f.inputTokens != null) attributes.push(i('gen_ai.usage.input_tokens', f.inputTokens));
  if (f.outputTokens != null) attributes.push(i('gen_ai.usage.output_tokens', f.outputTokens));

  const span: Record<string, unknown> = {
    traceId,
    spanId,
    name: 'chat n8n',
    kind: 3,
    startTimeUnixNano: `${startMs}000000`,
    attributes,
  };
  if (f.latencyMs != null) span.endTimeUnixNano = `${f.nowMs}000000`;

  return {
    traceId,
    body: {
      resourceSpans: [
        {
          resource: { attributes: [s('service.name', `n8n:${f.workflowName}`)] },
          scopeSpans: [{ scope: { name: 'n8n-nodes-verica' }, spans: [span] }],
        },
      ],
    },
  };
}
