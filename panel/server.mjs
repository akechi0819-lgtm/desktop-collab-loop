import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://ai-collab/panel.html';
const REQUIRED_ROLES = [
  'gemini_advisor',
  'codex_architect_audit',
  'codex_worker',
  'codex_worker_hard',
];

function parseArgs(argv) {
  const opts = {
    configPath: process.env.AI_COLLAB_CONFIG || path.join(os.homedir(), '.local/share/ai-collab/config.json'),
    defaultProject: process.env.AI_COLLAB_PROJECT || '',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) opts.configPath = argv[++i];
    else if (argv[i] === '--project' && argv[i + 1]) opts.defaultProject = argv[++i];
  }
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));
const IS_SAMPLE = OPTS.configPath.includes('/sample/');

function readConfig() {
  if (!fs.existsSync(OPTS.configPath)) {
    throw new Error(`配置文件不存在：${OPTS.configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(OPTS.configPath, 'utf8'));
  for (const key of REQUIRED_ROLES) {
    const r = raw?.roles?.[key];
    if (!r || !r.provider || !r.model || !r.effort) {
      throw new Error(`配置文件缺少角色字段 roles.${key}`);
    }
  }
  return raw;
}

function writeConfigAtomic(nextConfig) {
  fs.mkdirSync(path.dirname(OPTS.configPath), { recursive: true });
  const tmpPath = `${OPTS.configPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, OPTS.configPath);
}

function loadCodexModels(currentConfig) {
  const cachePath = path.join(os.homedir(), '.codex/models_cache.json');
  const selectedSlugs = new Set(
    Object.values(currentConfig.roles)
      .filter((r) => r.provider === 'codex')
      .map((r) => r.model)
  );
  if (!fs.existsSync(cachePath)) {
    return {
      source: 'fallback',
      models: [...selectedSlugs].map((slug) => ({
        id: slug,
        label: slug,
        efforts: ['low', 'medium', 'high', 'xhigh'],
      })),
    };
  }
  const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const list = Array.isArray(data?.models) ? data.models : [];
  const models = list
    .filter((m) => m && m.slug && (m.visibility === 'list' || selectedSlugs.has(m.slug)))
    .map((m) => ({
      id: m.slug,
      label: m.display_name || m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels) && m.supported_reasoning_levels.length
        ? m.supported_reasoning_levels.map((l) => l.effort).filter(Boolean)
        : ['low', 'medium', 'high'],
    }));
  return { source: 'codex_cache', models };
}

function loadAgyModels(currentConfig) {
  const agyBin = currentConfig.cli_paths.agy;
  const currentModel = currentConfig.roles.gemini_advisor.model;
  const knownEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

  try {
    const out = execFileSync(agyBin, ['models'], { encoding: 'utf8', timeout: 10000 });
    const rawItems = [];
    const familyEfforts = new Map();
    for (const rawLine of out.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('Fetching')) continue;
      const tabIdx = line.indexOf('\t');
      const id = (tabIdx > 0 ? line.slice(0, tabIdx) : line.split(/\s+/)[0]).trim();
      let label = tabIdx > 0 ? line.slice(tabIdx + 1).trim() : id;
      if (!/^[a-z0-9][a-z0-9._-]+$/i.test(id)) continue;
      if (/^claude/i.test(id)) label = `${label} · 额度紧`;
      const parts = id.split('-');
      const tail = parts[parts.length - 1];
      if (knownEfforts.has(tail) && parts.length > 1) {
        const fam = parts.slice(0, -1).join('-');
        if (!familyEfforts.has(fam)) familyEfforts.set(fam, []);
        familyEfforts.get(fam).push(tail);
      }
      rawItems.push({ id, label });
    }
    const order = ['low', 'medium', 'high', 'xhigh', 'max'];
    const parsed = rawItems.map(({ id, label }) => {
      const parts = id.split('-');
      const tail = parts[parts.length - 1];
      const fam = knownEfforts.has(tail) && parts.length > 1 ? parts.slice(0, -1).join('-') : null;
      const effs = fam && familyEfforts.has(fam)
        ? order.filter((e) => familyEfforts.get(fam).includes(e))
        : ['low', 'medium', 'high'];
      return { id, label, efforts: effs };
    });
    if (parsed.length > 0) {
      if (!parsed.some((m) => m.id === currentModel)) {
        parsed.unshift({ id: currentModel, label: currentModel, efforts: ['low', 'medium', 'high'] });
      }
      return { source: 'agy_cli', models: parsed };
    }
  } catch {
    // agy CLI not installed yet or not logged in; fall back cleanly.
  }

  return {
    source: 'sample_fallback',
    models: [{ id: currentModel, label: `${currentModel}（待安装 agy 同步）`, efforts: ['low', 'medium', 'high'] }],
  };
}

function findRecentCodexRollouts(maxFiles = 8) {
  const base = path.join(os.homedir(), '.codex/sessions');
  if (!fs.existsSync(base)) return [];
  const results = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try { results.push({ path: full, mtime: fs.statSync(full).mtimeMs }); } catch {}
      }
    }
  }
  walk(base, 0);
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, maxFiles);
}

function loadCodexUsage() {
  const files = findRecentCodexRollouts(8);
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file.path, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"token_count"')) continue;
      try {
        const obj = JSON.parse(line);
        const rl = obj?.payload?.rate_limits;
        if (!rl || (!rl.primary && !rl.secondary)) continue;
        return {
          available: true,
          planType: rl.plan_type || 'pro',
          snapshotAt: obj.timestamp || new Date(file.mtime).toISOString(),
          primary: rl.primary ? {
            usedPercent: Number(rl.primary.used_percent ?? 0),
            windowMinutes: Number(rl.primary.window_minutes ?? 0),
            resetsAt: rl.primary.resets_at ? Number(rl.primary.resets_at) * 1000 : null,
          } : null,
          secondary: rl.secondary ? {
            usedPercent: Number(rl.secondary.used_percent ?? 0),
            windowMinutes: Number(rl.secondary.window_minutes ?? 0),
            resetsAt: rl.secondary.resets_at ? Number(rl.secondary.resets_at) * 1000 : null,
          } : null,
        };
      } catch {
        continue;
      }
    }
  }
  return { available: false, reason: '未在近期 Codex 会话中找到限额快照' };
}

function loadAntigravityUsage(currentConfig) {
  const quotaPath = process.env.AI_COLLAB_QUOTA_PATH || path.join(os.homedir(), '.local/share/ai-collab/antigravity-quota.json');
  const percent = z.number().min(0).max(100);
  const resetTs = z.number().nullable().optional();
  const groupSchema = z.object({
    weeklyRemaining: percent,
    fiveHourRemaining: percent,
    weeklyResetAt: resetTs,
    fiveHourResetAt: resetTs,
  });
  const schema = z.object({
    source: z.string().min(1),
    sampledAt: z.string().datetime({ offset: true }),
    gemini: groupSchema,
    claudeGpt: groupSchema,
  });
  let refreshError;
  try {
    const agyBin = currentConfig.cli_paths.agy;
    const output = execFileSync(agyBin, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '15s'], { encoding: 'utf8', timeout: 20000 });
    const result = JSON.parse(output);
    if (result.status !== 'SUCCESS' || result.command?.name !== 'usage') throw new Error('无法识别 /usage 输出');
    const groups = result.command.data.groups;
    const findBucket = (name, window) => groups.find((group) => group.name === name)?.buckets.find((bucket) => bucket.window === window);
    const parseGroup = (name) => {
      const w = findBucket(name, 'weekly');
      const h = findBucket(name, '5h');
      const parseReset = (iso) => {
        if (!iso) return null;
        const ms = Date.parse(iso);
        return Number.isFinite(ms) && ms > 946684800000 ? ms : null;
      };
      return {
        weeklyRemaining: typeof w?.remaining_fraction === 'number' ? Math.round(w.remaining_fraction * 100) : undefined,
        fiveHourRemaining: typeof h?.remaining_fraction === 'number' ? Math.round(h.remaining_fraction * 100) : undefined,
        weeklyResetAt: parseReset(w?.reset_time),
        fiveHourResetAt: parseReset(h?.reset_time),
      };
    };
    const snapshot = schema.parse({
      source: 'agy /usage', sampledAt: new Date().toISOString(),
      gemini: parseGroup('Gemini Models'),
      claudeGpt: parseGroup('Claude and GPT models'),
    });
    fs.mkdirSync(path.dirname(quotaPath), { recursive: true });
    fs.writeFileSync(quotaPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    return { available: true, ...snapshot };
  } catch (err) {
    refreshError = `刷新失败：${err.message}`;
  }
  if (!fs.existsSync(quotaPath)) return { available: false, reason: refreshError };
  const snapshot = schema.parse(JSON.parse(fs.readFileSync(quotaPath, 'utf8')));
  return { available: true, ...snapshot, refreshError };
}

function loadProjectStatus(projectDir) {
  const dir = (projectDir || OPTS.defaultProject || '').trim();
  if (!dir) return { projectDir: '', found: false, status: '未指定项目' };

  const latestPath = path.join(dir, '.local/collab/latest-run.json');
  let latestRun = null;
  let handoffPath = path.join(dir, '.local/collab/handoff.md');

  if (fs.existsSync(latestPath)) {
    try {
      latestRun = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
      if (latestRun?.handoff_path) handoffPath = latestRun.handoff_path;
    } catch {
      latestRun = null;
    }
  }

  if (!fs.existsSync(handoffPath)) {
    return { projectDir: dir, found: false, status: '暂无交接记录', latestRun, handoffPath };
  }

  const text = fs.readFileSync(handoffPath, 'utf8');
  const lastStop = [...text.matchAll(/^停止[：:]\s*(.+)$/gm)].pop();
  const lastMorning = [...text.matchAll(/^##\s*(?:Gemini\s*白话晨报|白话晨报|晨报)[^\n]*\n([\s\S]*?)(?=\n##\s|\n停止[：:]|(?![\s\S]))/gm)].pop();
  const lastPending = [...text.matchAll(/^##\s*待验收[^\n]*\n([\s\S]*?)(?=\n##\s|\n停止[：:]|(?![\s\S]))/gm)].pop();
  const explicitStatus = text.match(/状态[：:]\s*([^\n]+)/);

  const events = [
    lastStop && { idx: lastStop.index, status: '失败停机', summary: `停止：${lastStop[1].trim()}` },
    lastMorning && { idx: lastMorning.index, status: '已完成', summary: lastMorning[1].trim().slice(0, 800) },
    lastPending && { idx: lastPending.index, status: '待验收', summary: lastPending[1].trim().slice(0, 800) },
  ].filter(Boolean).sort((a, b) => b.idx - a.idx);

  let status = '进行中';
  let summary = '';
  if (events.length > 0) {
    status = events[0].status;
    summary = events[0].summary;
  } else {
    if (explicitStatus) status = explicitStatus[1].trim();
    summary = text.split('\n').slice(0, 12).join('\n').slice(0, 800);
  }

  return {
    projectDir: dir,
    found: true,
    status,
    latestRun,
    handoffPath,
    summary,
  };
}

function buildState(projectDir) {
  const config = readConfig();
  const codexCatalog = loadCodexModels(config);
  const agyCatalog = loadAgyModels(config);
  return {
    configPath: OPTS.configPath,
    isSample: IS_SAMPLE,
    config,
    catalog: {
      codex: codexCatalog,
      agy: agyCatalog,
    },
    usage: {
      codex: loadCodexUsage(),
      antigravity: loadAntigravityUsage(config),
    },
    project: loadProjectStatus(projectDir),
  };
}

const server = new McpServer(
  { name: 'ai-collab-panel', version: '0.2.0' },
  { capabilities: { resources: {}, tools: {} } }
);

server.registerResource(
  'panel-ui',
  APP_URI,
  {
    title: '模型协同面板',
    description: '多模型协同调度侧边栏 UI',
    mimeType: 'text/html;profile=mcp-app',
    _meta: { ui: { prefersBorder: false } },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: fs.readFileSync(path.join(__dirname, 'dist/app.html'), 'utf8'),
      },
    ],
  })
);

server.registerTool(
  'open_collab_panel',
  {
    title: '模型协同面板',
    description: '打开多模型协同侧边栏面板，查看各 Harness 用量余额、切换角色模型与思考强度，并查看交接晨报',
    inputSchema: {
      project_dir: z.string().optional().describe('可选：要查看交接状态的项目目录绝对路径'),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: '模型协同面板' },
          { type: 'global', title: '模型协同面板' },
        ],
      },
    },
  },
  async ({ project_dir }) => {
    const state = buildState(project_dir);
    return {
      content: [
        {
          type: 'text',
          text: `已打开模型协同面板（${state.isSample ? '样例配置' : '正式配置'}：${state.configPath}）。`,
        },
      ],
      structuredContent: state,
    };
  }
);

const roleSchema = z.object({
  provider: z.enum(['agy', 'codex']),
  model: z.string().min(1),
  effort: z.string().min(1),
});

server.registerTool(
  'save_collab_config',
  {
    title: '保存模型协同配置',
    description: '原子写入 config.json',
    inputSchema: {
      roles: z.object({
        gemini_advisor: roleSchema,
        codex_architect_audit: roleSchema,
        codex_worker: roleSchema,
        codex_worker_hard: roleSchema,
      }),
      timeouts: z.object({
        agy_seconds: z.number().int().min(30).max(3600),
        codex_seconds: z.number().int().min(30).max(7200),
      }),
      max_review_rounds: z.number().int().min(1).max(2),
      project_dir: z.string().optional(),
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  async ({ roles, timeouts, max_review_rounds, project_dir }) => {
    const normalized = JSON.parse(JSON.stringify(roles));
    for (const r of Object.values(normalized)) {
      if (r.provider === 'agy') {
        const parts = r.model.split('-');
        const tail = parts[parts.length - 1];
        if (['low', 'medium', 'high', 'xhigh', 'max'].includes(tail) && parts.length > 1) {
          r.model = `${parts.slice(0, -1).join('-')}-${r.effort}`;
        }
      }
    }
    writeConfigAtomic({ ...readConfig(), roles: normalized, timeouts, max_review_rounds });
    const state = buildState(project_dir);
    return {
      content: [{ type: 'text', text: `已保存配置到 ${state.configPath}` }],
      structuredContent: state,
    };
  }
);

server.registerTool(
  'load_project_status',
  {
    title: '刷新面板状态',
    description: '重新读取本机模型列表、各 Harness 用量快照与指定项目的交接状态',
    inputSchema: {
      project_dir: z.string().optional(),
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  async ({ project_dir }) => {
    const state = buildState(project_dir);
    return {
      content: [{ type: 'text', text: `已刷新（项目状态：${state.project.status}）` }],
      structuredContent: state,
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
