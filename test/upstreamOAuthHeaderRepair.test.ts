import {test,expect} from 'vitest';
import {validateHeaderValue} from 'node:http';
import {loadConfig} from '../src/config.js';
import {oauthChallenge} from '../src/mcpOAuth.js';
const profile={CODEX_MCP_BRIDGE_OAUTH_ISSUER:'https://issuer.example/tenant/',CODEX_MCP_BRIDGE_OAUTH_RESOURCE:'https://resource.example/mcp',CODEX_MCP_BRIDGE_OAUTH_JWKS_URI:'https://issuer.example/keys',CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT:'fixture-operator',CODEX_MCP_BRIDGE_TOKEN:'private-fixture-sealing-secret-1234567890'};
for(const metadata of ['https://metadata.example/\u0100','https://\u4f8b\u5b50.example/.well-known/oauth-protected-resource/mcp','https://metadata.example/caf\u00e9'])test('metadata original URL requires ASCII hostname/encoded path '+metadata,()=>{expect(()=>loadConfig({...profile,CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL:metadata})).toThrow('ASCII');});
for(const metadata of ['https://metadata.example/%C4%80','https://xn--fsqu00a.example/.well-known/oauth-protected-resource/mcp'])test('encoded ordinary HTTPS metadata remains exact and valid '+metadata,()=>{const config=loadConfig({...profile,CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL:metadata});expect(config.oauth?.resourceMetadataUrl).toBe(metadata);expect(()=>validateHeaderValue('WWW-Authenticate',oauthChallenge(config.oauth!))).not.toThrow();});
