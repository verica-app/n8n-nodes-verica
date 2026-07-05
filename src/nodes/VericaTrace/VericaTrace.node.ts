import type {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import {
  buildTracePayload,
  coerceText,
  inferProvider,
  normalizeIntermediateSteps,
  randomHex,
} from '../../mapper';

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class VericaTrace implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Verica Trace',
    name: 'vericaTrace',
    icon: 'file:verica.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter.model || "trace" }}',
    description: 'Sends the previous AI step to Verica as an evaluable trace',
    defaults: { name: 'Verica Trace' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'vericaApi', required: true }],
    properties: [
      {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default: '',
        placeholder: 'gpt-4o',
        description:
          "The model the upstream AI step used (needed to price the trace). With \"Message a model\" use {{ $json.model }}; with an AI Agent read the chat-model sub-node's parameter, e.g. {{ $('OpenAI Chat Model').params.model.value || $('OpenAI Chat Model').params.model }}.",
      },
      {
        displayName: 'Input',
        name: 'input',
        type: 'string',
        default: '={{ $json.chatInput || "" }}',
        description:
          "Defaults to $json.chatInput; for a chat workflow point it at your trigger, e.g. {{ $('When chat message received').item.json.chatInput }}. \"Message a model\" does not echo the prompt: read it from the node's parameters, e.g. {{ $('Message a model').params.responses.values[0].content }} (hover the Prompt field to confirm the path).",
      },
      {
        displayName: 'Output',
        name: 'output',
        type: 'string',
        default: '={{ $json.output || "" }}',
        description:
          'The model/agent answer. Object shapes (AI Agent output, "Message a model" responses) are flattened to text automatically.',
      },
      {
        displayName: 'Tool Calls',
        name: 'toolCalls',
        type: 'json',
        default: '={{ $json.intermediateSteps || $json.output || [] }}',
        description:
          'AI Agent intermediate steps (enable "Return intermediate steps" on the agent), else a raw output array containing tool/function calls; non-tool entries are ignored. Note: "Message a model" with attached tools runs its tool loop internally and returns only the final answer, so its executed calls are not capturable; use the AI Agent for tool-using workflows.',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
          {
            displayName: 'Provider',
            name: 'provider',
            type: 'options',
            options: [
              { name: 'Auto (from model)', value: 'auto' },
              { name: 'OpenAI', value: 'openai' },
              { name: 'Anthropic', value: 'anthropic' },
              { name: 'Google', value: 'google' },
            ],
            default: 'auto',
          },
          {
            displayName: 'Session ID',
            name: 'sessionId',
            type: 'string',
            default: '={{ $json.sessionId || "" }}',
            description:
              "Defaults to $json.sessionId; for a chat workflow point it at your trigger, e.g. {{ $('When chat message received').item.json.sessionId }}",
          },
          {
            displayName: 'Input Tokens',
            name: 'inputTokens',
            type: 'string',
            default:
              '={{ ($json.usage || {}).input_tokens ?? ($json.usage || {}).prompt_tokens ?? "" }}',
            description:
              'Auto-reads OpenAI usage (input_tokens/prompt_tokens) from the response when present',
          },
          {
            displayName: 'Output Tokens',
            name: 'outputTokens',
            type: 'string',
            default:
              '={{ ($json.usage || {}).output_tokens ?? ($json.usage || {}).completion_tokens ?? "" }}',
            description:
              'Auto-reads OpenAI usage (output_tokens/completion_tokens) from the response when present',
          },
          {
            displayName: 'Reasoning Tokens',
            name: 'reasoningTokens',
            type: 'string',
            default:
              '={{ (($json.usage || {}).output_tokens_details || {}).reasoning_tokens ?? (($json.usage || {}).completion_tokens_details || {}).reasoning_tokens ?? "" }}',
            description:
              'A breakdown of output tokens. Auto-reads OpenAI usage (output_tokens_details/completion_tokens_details.reasoning_tokens) from the response when present.',
          },
          {
            displayName: 'Cached Tokens',
            name: 'cachedTokens',
            type: 'string',
            default:
              '={{ (($json.usage || {}).input_tokens_details || {}).cached_tokens ?? (($json.usage || {}).prompt_tokens_details || {}).cached_tokens ?? "" }}',
            description:
              'A breakdown of input tokens. Auto-reads OpenAI usage (input_tokens_details/prompt_tokens_details.cached_tokens) from the response when present.',
          },
          { displayName: 'Latency (Ms)', name: 'latencyMs', type: 'string', default: '' },
          {
            displayName: 'Tags',
            name: 'tags',
            type: 'string',
            default: '',
            description: 'Comma-separated tags added to the trace',
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    // Fail-open: credential/endpoint resolution must NEVER break the host
    // workflow either. On failure, annotate every item and pass them through.
    let endpoint: string;
    try {
      const credentials = await this.getCredentials('vericaApi');
      endpoint = String(credentials.endpoint ?? 'https://ingest.verica.app').replace(/\/+$/, '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        items.map((item, i) => ({
          json: { ...item.json, vericaError: message },
          pairedItem: { item: i },
        })),
      ];
    }
    const returned: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const out: INodeExecutionData = { json: { ...items[i]!.json }, pairedItem: { item: i } };
      // Fail-open: a tracing node must NEVER break the host workflow. Any error
      // (bad expression, receiver down, 401) is annotated on the item instead.
      try {
        const options = this.getNodeParameter('options', i, {}) as Record<string, unknown>;
        const model = String(this.getNodeParameter('model', i, ''));
        const provider =
          options.provider == null || options.provider === 'auto'
            ? inferProvider(model)
            : String(options.provider);
        const payload = buildTracePayload({
          input: coerceText(this.getNodeParameter('input', i, '')),
          output: coerceText(this.getNodeParameter('output', i, '')),
          toolCalls: normalizeIntermediateSteps(this.getNodeParameter('toolCalls', i, [])),
          model,
          provider,
          sessionId: String(options.sessionId ?? ''),
          inputTokens: numOrNull(options.inputTokens),
          outputTokens: numOrNull(options.outputTokens),
          reasoningTokens: numOrNull(options.reasoningTokens),
          cachedTokens: numOrNull(options.cachedTokens),
          latencyMs: numOrNull(options.latencyMs),
          tags: String(options.tags ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
          workflowName: this.getWorkflow().name ?? '',
          executionId: this.getExecutionId(),
          nowMs: Date.now(),
          randomHex,
        });
        await this.helpers.httpRequestWithAuthentication.call(this, 'vericaApi', {
          method: 'POST',
          url: `${endpoint}/v1/traces`,
          headers: { 'x-verica-source': 'n8n' },
          body: payload.body as IDataObject,
          json: true,
        });
        out.json.vericaTraceId = payload.traceId;
      } catch (error) {
        out.json.vericaError = error instanceof Error ? error.message : String(error);
      }
      returned.push(out);
    }
    return [returned];
  }
}
