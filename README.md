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
   `$json.sessionId`; set **Model** so the trace can be priced.
3. Enable **Return intermediate steps** on the AI Agent so tool calls land in
   the trace (Verica's `tool_check` grader can then assert on them).

The node is **fail-open**: an export error never breaks your workflow; the item
passes through with a `vericaError` annotation instead.

## License

MIT
