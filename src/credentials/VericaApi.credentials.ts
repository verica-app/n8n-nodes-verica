import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class VericaApi implements ICredentialType {
  name = 'vericaApi';
  displayName = 'Verica API';
  documentationUrl = 'https://verica.app';
  properties: INodeProperties[] = [
    {
      displayName: 'Ingest Token',
      name: 'token',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'A Verica API token with the ingest scope (Configuración → Tokens)',
    },
    {
      displayName: 'Endpoint',
      name: 'endpoint',
      type: 'string',
      default: 'https://ingest.verica.app',
      description: 'Only change this for self-hosted Verica instances',
    },
  ];
  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.token}}' } },
  };
  // An empty OTLP export: authenticates (202) without ingesting anything.
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.endpoint}}',
      url: '/v1/traces',
      method: 'POST',
      body: { resourceSpans: [] },
      json: true,
    },
  };
}
