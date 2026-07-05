# n8n-nodes-verica

n8n community node that sends your AI Agent / LLM executions to
[Verica](https://verica.app) as evaluable traces.

## Install

- **Self-hosted n8n**: Settings → Community Nodes → Install `n8n-nodes-verica`.
- **n8n Cloud**: available once the node is verified; meanwhile use the
  importable recipe from Verica's Connect dialog (Traces → Connect → n8n).

## Usage

1. Create a **Verica API** credential: an ingest token (Verica → Settings →
   API tokens, with the `ingest` scope). The endpoint defaults to the Verica
   cloud.
2. Drop **Verica Trace** after your AI Agent (or any LLM step). The defaults
   read `$json.output`, `$json.chatInput`, `$json.intermediateSteps` and
   `$json.sessionId`; set **Model** so the trace can be priced. It works after
   the AI Agent or "Message a model" out of the box: object outputs are
   flattened to text automatically.
3. Enable **Return intermediate steps** on the AI Agent so tool calls land in
   the trace (Verica's `tool_check` grader can then assert on them).

With **"Message a model"** (OpenAI Responses API), token usage is picked up
from the response automatically: adding the **Input Tokens** / **Output
Tokens** options captures the response's `usage`, including the **Reasoning
Tokens** (a breakdown of output tokens) and **Cached Tokens** (a breakdown of
input tokens, priced at the cache rate) when the response reports them. The
response does not echo your prompt: map **Input** to the node's parameter,
e.g. `{{ $('Message a model').params.responses.values[0].content }}` (hover
the Prompt field to confirm the parameter path in your n8n version).

**Tool calls in the trace need a node that emits them.** The AI Agent does
(enable **Return intermediate steps**); "Message a model" with attached tools
runs its tool loop internally and returns only the final answer, so its
executed calls are not capturable downstream. For tool-using workflows, use
the AI Agent.

With an **AI Agent**, map **Model** to the chat-model sub-node's parameter,
e.g. `{{ $('OpenAI Chat Model').params.model.value || $('OpenAI Chat Model').params.model }}`.
Token usage is NOT capturable in agent workflows: n8n does not propagate the
chat model's `tokenUsage` to the agent output or to downstream expressions
(open issue [n8n#26302](https://github.com/n8n-io/n8n/issues/26302)); the
trace lands without tokens/cost but stays fully evaluable.

The node is **fail-open**: an export error never breaks your workflow; the item
passes through with a `vericaError` annotation instead.

## License

MIT
