// n8n loads credentials/nodes from the dist paths in package.json's "n8n" block;
// this barrel only serves programmatic consumers (tests, the web recipe check).
export { buildTracePayload, inferProvider, normalizeIntermediateSteps, randomHex } from './mapper';
export type { ToolCallInput, TraceFields } from './mapper';
