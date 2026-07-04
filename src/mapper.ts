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

/** Best-effort text from common LLM output shapes; never '[object Object]'. */
export function coerceText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(coerceText).filter(Boolean).join('\n');
  const rec = value as Record<string, unknown>;
  for (const key of ['output_text', 'text', 'content', 'message', 'output', 'choices']) {
    if (key in rec) {
      const t = coerceText(rec[key]);
      if (t.length > 0) return t;
    }
  }
  return JSON.stringify(value);
}

/** Mirror of the Ruby SDK's Verica::Providers.for_model heuristic. */
export function inferProvider(model: string): string {
  if (model.length === 0) return '';
  const m = model.toLowerCase();
  if (m.startsWith('gemini')) return 'google';
  if (m.includes('claude')) return 'anthropic';
  return 'openai';
}

/**
 * Normalize an array of tool-call entries into {tool,toolInput} pairs. Accepts,
 * per entry, any of:
 *  - LangChain intermediateSteps: {action:{tool,toolInput}} or flat {tool,toolInput}
 *  - OpenAI Responses API output item: {type:'function_call', name, arguments}
 *    (arguments is a JSON string; passed through as-is)
 *  - Chat-completions tool_calls: {function:{name, arguments}}
 * Entries matching none of these (e.g. {type:'message',...} items mixed into a
 * Responses output array) are silently ignored.
 */
export function normalizeIntermediateSteps(raw: unknown): ToolCallInput[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCallInput[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;

    // OpenAI Responses API output item.
    if (rec.type === 'function_call' && typeof rec.name === 'string' && rec.name.length > 0) {
      out.push({ tool: rec.name, toolInput: rec.arguments });
      continue;
    }

    // Chat-completions tool_calls entry.
    if (rec.function != null && typeof rec.function === 'object') {
      const fn = rec.function as Record<string, unknown>;
      if (typeof fn.name === 'string' && fn.name.length > 0) {
        out.push({ tool: fn.name, toolInput: fn.arguments });
        continue;
      }
    }

    // LangChain: {action:{tool,toolInput}} or flat {tool,toolInput}.
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
