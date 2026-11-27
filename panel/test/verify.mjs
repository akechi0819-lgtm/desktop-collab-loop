import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-panel-test-'));
const home = path.join(temp, 'home');
const config = path.join(temp, 'sample', 'config.json');
const project = path.join(temp, 'project');
const bin = path.join(home, '.local/bin');
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(path.join(project, '.local/collab'), { recursive: true });
fs.copyFileSync(path.join(root, 'sample/config.json'), config);
fs.writeFileSync(path.join(project, '.local/collab/handoff.md'), '## 待验收\n合成测试项目\n');
const agy = path.join(bin, 'agy');
const sampleConfig = JSON.parse(fs.readFileSync(config, 'utf8'));
sampleConfig.cli_paths.agy = agy;
fs.writeFileSync(config, JSON.stringify(sampleConfig));
fs.writeFileSync(agy, `#!/bin/sh
if [ "$1" = models ]; then
  printf 'gemini-4-neon-medium\\tGemini test\\n'
else
  printf '%s\\n' '{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"weekly","remaining_fraction":0.8},{"window":"5h","remaining_fraction":0.7}]},{"name":"Claude and GPT models","buckets":[{"window":"weekly","remaining_fraction":0.6},{"window":"5h","remaining_fraction":0.5}]}]}}}'
fi
`, { mode: 0o755 });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'server.mjs'), '--config', config, '--project', project],
  env: { HOME: home, PATH: bin, AI_COLLAB_QUOTA_PATH: path.join(temp, 'quota.json') },
});
const client = new Client({ name: 'verify-client', version: '0.2.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.find((t) => t.name === 'open_collab_panel')?._meta?.ui?.resourceUri, 'ui://ai-collab/panel.html');
  const resource = await client.readResource({ uri: 'ui://ai-collab/panel.html' });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.contents[0].text.includes('quota-grid'));
  const state = (await client.callTool({ name: 'open_collab_panel', arguments: {} })).structuredContent;
  assert.equal(state.isSample, true);
  assert.equal(state.catalog.agy.source, 'agy_cli');
  assert.equal(state.catalog.codex.source, 'fallback');
  assert.equal(state.usage.codex.available, false);
  assert.equal(state.usage.antigravity.gemini.weeklyRemaining, 80);
  assert.equal(state.project.status, '待验收');
  const roles = structuredClone(state.config.roles);
  roles.codex_worker.effort = 'high';
  const saved = await client.callTool({ name: 'save_collab_config', arguments: {
    roles, timeouts: state.config.timeouts, max_review_rounds: state.config.max_review_rounds, project_dir: project,
  } });
  assert.equal(saved.structuredContent.config.roles.codex_worker.effort, 'high');
  const written = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(written.roles.codex_worker.effort, 'high');
  assert.deepEqual(written.cli_paths, sampleConfig.cli_paths);
  console.log('PASS: panel resource, synthetic catalogs, quota, project status and configuration save');
} finally {
  await client.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
