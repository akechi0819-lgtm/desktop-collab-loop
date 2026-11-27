import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';

const ROLE_META = [
  { key: 'gemini_advisor', name: '需求 / 前端 / 需求验收', accent: 'accent-agy', tag: 'agy', desc: '需求对齐、文案审美、砍过度设计' },
  { key: 'codex_architect_audit', name: '施工文档 / 技术终审', accent: 'accent-audit', tag: 'Codex 只读', desc: '审 PRD、出 spec.md、终审技术底线' },
  { key: 'codex_worker', name: '日常机械施工 Worker', accent: 'accent-worker', tag: 'Codex 施工', desc: '按定稿施工单写代码、跑回归测试' },
  { key: 'codex_worker_hard', name: '疑难攻坚 Worker', accent: 'accent-hard', tag: 'Codex 攻坚', desc: '跨文件归属不清、复杂逻辑或疑难 Bug' },
];

const app = new App({ name: 'ai-collab-panel', version: '0.3.0' }, {});
let state = null;
let draft = null;
let dirty = false;
let toast = { text: '就绪', kind: '' };
let saving = false;
let refreshing = false;
let autoRefreshedOnce = false;

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getCatalogFor(provider) {
  return state?.catalog?.[provider]?.models || [];
}

function getEffortsFor(provider, modelId) {
  const found = getCatalogFor(provider).find((m) => m.id === modelId);
  return found?.efforts?.length ? found.efforts : ['low', 'medium', 'high'];
}

function formatResetTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

function formatWindow(mins) {
  if (!mins) return '当前窗口';
  if (mins >= 1440) return `${Math.round(mins / 1440)}天窗口`;
  return `${Math.round(mins / 60)}小时窗口`;
}

function formatRelative(iso) {
  if (!iso) return '';
  const diffMin = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const h = Math.round(diffMin / 60);
  return h < 24 ? `${h}小时前` : `${Math.round(h / 24)}天前`;
}

function barClass(usedPct) {
  if (usedPct >= 85) return 'low';
  if (usedPct >= 60) return 'mid';
  return 'good';
}

function statusPillClass(status) {
  if (!status) return '';
  if (status.includes('完成')) return 'ok';
  if (status.includes('失败') || status.includes('停机')) return 'err';
  if (status.includes('待验收')) return 'warn';
  return '';
}

function renderCodexQuotaCard(u) {
  if (!u?.available || !u.primary) {
    return `
      <div class="quota-card codex">
        <div class="quota-top">
          <span class="quota-name">Codex</span>
          <span class="quota-plan">GPT Pro</span>
        </div>
        <div class="quota-foot">${escapeHtml(u?.reason || '暂无本地限额快照')}</div>
      </div>
    `;
  }
  const used = Math.min(100, Math.max(0, Math.round(u.primary.usedPercent)));
  const remain = 100 - used;
  const planLabel = u.planType === 'prolite' ? 'Pro $100' : String(u.planType || 'Pro').toUpperCase();
  const secHtml = u.secondary ? `
    <div style="margin-top:2px;">
      <div class="quota-foot" style="display:flex;justify-content:space-between;">
        <span>${formatWindow(u.secondary.windowMinutes)}</span>
        <span>剩余 ${Math.max(0, 100 - Math.round(u.secondary.usedPercent))}%</span>
      </div>
      <div class="bar-track" style="height:4px;margin-top:3px;">
        <div class="bar-fill ${barClass(u.secondary.usedPercent)}" style="width:${Math.max(0, 100 - Math.round(u.secondary.usedPercent))}%"></div>
      </div>
    </div>
  ` : '';

  return `
    <div class="quota-card codex ${refreshing ? 'refreshing' : ''}">
      <div class="quota-top">
        <span class="quota-name">Codex</span>
        <span class="quota-plan">${escapeHtml(planLabel)}</span>
      </div>
      <div class="quota-big">
        <div><span class="quota-num">${remain}%</span> <span class="quota-unit">剩余</span></div>
        <span class="quota-unit">已用 ${used}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${barClass(used)}" style="width:${remain}%"></div>
      </div>
      ${secHtml}
      <div class="quota-foot">
        ${formatWindow(u.primary.windowMinutes)}${u.primary.resetsAt ? ` · 重置 ${formatResetTime(u.primary.resetsAt)}` : ''}<br/>
        快照 ${formatRelative(u.snapshotAt)}
      </div>
    </div>
  `;
}

function renderAgyQuotaCard(u) {
  if (!u?.available || !u.gemini) {
    return `
      <div class="quota-card agy">
        <div class="quota-top">
          <span class="quota-name">Antigravity</span>
          <span class="quota-plan">AI Pro</span>
        </div>
        <div class="quota-foot">${escapeHtml(u?.reason || '暂无官方用量快照')}</div>
      </div>
    `;
  }
  const gWeek = Math.min(100, Math.max(0, Math.round(u.gemini.weeklyRemaining)));
  const g5h = Math.min(100, Math.max(0, Math.round(u.gemini.fiveHourRemaining)));
  const cgWeek = Math.min(100, Math.max(0, Math.round(u.claudeGpt?.weeklyRemaining ?? 0)));
  const cg5h = Math.min(100, Math.max(0, Math.round(u.claudeGpt?.fiveHourRemaining ?? 0)));
  const gResets = [
    u.gemini.weeklyResetAt ? `周重置 ${formatResetTime(u.gemini.weeklyResetAt)}` : '',
    u.gemini.fiveHourResetAt ? `5h重置 ${formatResetTime(u.gemini.fiveHourResetAt).slice(6)}` : '',
  ].filter(Boolean).join(' · ');
  const cgReset = u.claudeGpt?.weeklyResetAt ? `周重置 ${formatResetTime(u.claudeGpt.weeklyResetAt)}` : '';

  return `
    <div class="quota-card agy ${refreshing ? 'refreshing' : ''}">
      <div class="quota-top">
        <span class="quota-name">Antigravity</span>
        <span class="quota-plan">AI Pro</span>
      </div>
      <div class="quota-big">
        <div><span class="quota-num">${gWeek}%</span> <span class="quota-unit">Gemini 周余</span></div>
        <span class="quota-unit">5h ${g5h}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill ${barClass(100 - gWeek)}" style="width:${gWeek}%"></div>
      </div>
      ${gResets ? `<div class="quota-foot">${gResets}</div>` : ''}
      <div class="sub-metric">
        <div class="sub-metric-row">
          <span>Claude/GPT</span>
          <span>周 ${cgWeek}% · 5h ${cg5h}%</span>
        </div>
        <div class="bar-track thin">
          <div class="bar-fill ${barClass(100 - cgWeek)}" style="width:${cgWeek}%"></div>
        </div>
        ${cgReset ? `<div class="quota-foot">${cgReset}</div>` : ''}
      </div>
      <div class="quota-foot">
        ${escapeHtml(u.source || 'agy /usage')} · 快照 ${formatRelative(u.sampledAt)}
        ${u.refreshError ? `<div class="quota-warn">${escapeHtml(u.refreshError)}</div>` : ''}
      </div>
    </div>
  `;
}

function render() {
  const root = document.getElementById('root');
  if (!state || !draft) {
    root.innerHTML = '<div class="sec-sub">等待面板数据…</div>';
    return;
  }

  const rolesHtml = ROLE_META.map((meta) => {
    const cur = draft.roles[meta.key];
    const models = getCatalogFor(cur.provider);
    const efforts = getEffortsFor(cur.provider, cur.model);
    const modelOptions = models.map((m) =>
      `<option value="${escapeHtml(m.id)}" ${m.id === cur.model ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
    ).join('');
    const effortPills = efforts.map((e) =>
      `<button type="button" class="seg-btn" data-role="${meta.key}" data-effort="${escapeHtml(e)}" data-active="${e === cur.effort}">${escapeHtml(e)}</button>`
    ).join('');

    return `
      <div class="role-card ${meta.accent}">
        <div class="role-top">
          <span class="role-name">${escapeHtml(meta.name)}</span>
          <span class="pill">${escapeHtml(meta.tag)}</span>
        </div>
        <div class="role-desc">${escapeHtml(meta.desc)}</div>
        <select data-role="${meta.key}" data-field="model">${modelOptions}</select>
        <div class="effort-row">
          <span class="effort-lbl">强度</span>
          <div class="seg">${effortPills}</div>
        </div>
      </div>
    `;
  }).join('');

  const proj = state.project || {};
  const handoffBtn = proj.found && proj.handoffPath
    ? `<button id="btn-open-handoff" type="button" class="btn-ghost">打开</button>`
    : '';

  root.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span class="title">模型协同面板</span>
      </div>
      <div class="topbar-right">
        <span class="pill ${state.isSample ? 'warn' : 'ok'}">${state.isSample ? '样例配置' : '正式配置'}</span>
        <button id="btn-refresh" type="button" class="icon-btn" ${saving || refreshing ? 'disabled' : ''}>
          <svg class="spin-icon ${refreshing ? 'spinning' : ''}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.3-3.6M13.5 2.5v2.9h-2.9"/>
          </svg>
          <span>${refreshing ? '刷新中…' : '刷新'}</span>
        </button>
      </div>
    </div>

    <div>
      <div class="sec-head">
        <span class="sec-title">Harness 用量与状态</span>
        <span class="sec-sub">${refreshing ? '正在同步最新额度…' : '本地缓存秒开 · 点刷新同步'}</span>
      </div>
      <div class="quota-grid">
        ${renderCodexQuotaCard(state.usage?.codex)}
        ${renderAgyQuotaCard(state.usage?.antigravity)}
      </div>
    </div>

    <div>
      <div class="sec-head">
        <span class="sec-title">角色模型与思考强度</span>
        <span class="sec-sub">${state.catalog.codex.models.length} Codex · ${state.catalog.agy.models.length} agy</span>
      </div>
      <div class="roles-list">${rolesHtml}</div>
    </div>

    <details class="adv">
      <summary>
        <span>超时与审查轮数</span>
        <span class="mono">agy ${draft.timeouts.agy_seconds}s · Codex ${draft.timeouts.codex_seconds}s · ${draft.max_review_rounds} 轮</span>
      </summary>
      <div class="adv-grid">
        <div>
          <label class="field-lbl">agy 超时（秒）</label>
          <input id="inp-agy-timeout" type="number" min="30" max="3600" value="${draft.timeouts.agy_seconds}" />
        </div>
        <div>
          <label class="field-lbl">Codex 超时（秒）</label>
          <input id="inp-codex-timeout" type="number" min="30" max="7200" value="${draft.timeouts.codex_seconds}" />
        </div>
        <div>
          <label class="field-lbl">最大轮数</label>
          <input id="inp-rounds" type="number" min="1" max="2" value="${draft.max_review_rounds}" />
        </div>
      </div>
    </details>

    <div class="save-bar ${dirty ? 'dirty' : ''}">
      <span class="toast ${toast.kind}">${escapeHtml(toast.text)}</span>
      <button id="btn-save" type="button" class="btn-primary" ${saving ? 'disabled' : ''}>${saving ? '保存中…' : (dirty ? '保存更改' : '保存配置')}</button>
    </div>

    <div>
      <div class="sec-head">
        <span class="sec-title">项目交接与晨报</span>
        <span class="pill ${statusPillClass(proj.status)}">${escapeHtml(proj.status || '未知')}</span>
      </div>
      <div class="handoff-card">
        <div class="path-row">
          <input id="inp-project-dir" type="text" placeholder="项目绝对路径" value="${escapeHtml(proj.projectDir || '')}" />
          <button id="btn-load-project" type="button" class="btn-ghost">查看</button>
          ${handoffBtn}
        </div>
        ${proj.latestRun?.work_dir ? `<div class="sec-sub mono">${escapeHtml(proj.latestRun.mode || '')} · ${escapeHtml(proj.latestRun.work_dir)}</div>` : ''}
        ${proj.summary ? `<div class="summary-box">${escapeHtml(proj.summary)}</div>` : `<div class="sec-sub">当前目录暂无交接晨报。</div>`}
      </div>
    </div>

    <div class="footnote">
      配置路径：<span class="mono">${escapeHtml(state.configPath)}</span><br/>
      生效范围：控制所有协作脚本调用（agy-ask、codex-ask、独立 Worker、night-run）；不改变独立 Desktop 聊天框里你手动选的窗口自身模型。
    </div>
  `;

  root.querySelectorAll('select[data-role]').forEach((el) => {
    el.addEventListener('change', (ev) => {
      const roleKey = ev.target.dataset.role;
      const val = ev.target.value;
      draft.roles[roleKey].model = val;
      const allowed = getEffortsFor(draft.roles[roleKey].provider, val);
      const tail = val.split('-').pop();
      if (draft.roles[roleKey].provider === 'agy' && allowed.includes(tail)) {
        draft.roles[roleKey].effort = tail;
      } else if (!allowed.includes(draft.roles[roleKey].effort)) {
        draft.roles[roleKey].effort = allowed.includes('medium') ? 'medium' : allowed[0];
      }
      dirty = true;
      toast = { text: '有未保存更改', kind: '' };
      render();
    });
  });

  root.querySelectorAll('button[data-effort]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const roleKey = ev.currentTarget.dataset.role;
      const eff = ev.currentTarget.dataset.effort;
      if (draft.roles[roleKey].effort === eff) return;
      draft.roles[roleKey].effort = eff;
      if (draft.roles[roleKey].provider === 'agy') {
        const curModel = draft.roles[roleKey].model;
        const parts = curModel.split('-');
        const tail = parts[parts.length - 1];
        if (['low', 'medium', 'high', 'xhigh', 'max'].includes(tail) && parts.length > 1) {
          const synced = `${parts.slice(0, -1).join('-')}-${eff}`;
          if (getCatalogFor('agy').some((m) => m.id === synced)) {
            draft.roles[roleKey].model = synced;
          }
        }
      }
      dirty = true;
      toast = { text: '有未保存更改', kind: '' };
      render();
    });
  });

  document.getElementById('inp-agy-timeout')?.addEventListener('change', (e) => {
    draft.timeouts.agy_seconds = Number(e.target.value) || 300;
    dirty = true;
    toast = { text: '有未保存更改', kind: '' };
  });
  document.getElementById('inp-codex-timeout')?.addEventListener('change', (e) => {
    draft.timeouts.codex_seconds = Number(e.target.value) || 900;
    dirty = true;
    toast = { text: '有未保存更改', kind: '' };
  });
  document.getElementById('inp-rounds')?.addEventListener('change', (e) => {
    draft.max_review_rounds = Number(e.target.value) || 2;
    dirty = true;
    toast = { text: '有未保存更改', kind: '' };
  });

  document.getElementById('btn-save')?.addEventListener('click', handleSave);
  document.getElementById('btn-refresh')?.addEventListener('click', () => handleRefresh(undefined, { refresh: true }));
  document.getElementById('btn-load-project')?.addEventListener('click', () => {
    const p = document.getElementById('inp-project-dir')?.value?.trim() || '';
    handleRefresh(p, { refresh: false });
  });
  document.getElementById('btn-open-handoff')?.addEventListener('click', async () => {
    if (!proj.handoffPath) return;
    try {
      await app.request(
        { method: 'com.google.antigravity/toggle-aux-pane', params: { tabType: 'fileView', uri: `file://${proj.handoffPath}` } },
        z.object({ isError: z.boolean().optional() }).passthrough()
      );
    } catch {
      toast = { text: '当前视图不支持侧栏打开文件', kind: 'err' };
      render();
    }
  });
}

async function handleSave() {
  saving = true;
  toast = { text: '正在保存…', kind: '' };
  render();
  try {
    const projectDir = document.getElementById('inp-project-dir')?.value?.trim() || state.project?.projectDir || '';
    const res = await app.callServerTool({
      name: 'save_collab_config',
      arguments: {
        roles: draft.roles,
        timeouts: draft.timeouts,
        max_review_rounds: draft.max_review_rounds,
        project_dir: projectDir || undefined,
      },
    });
    if (res?.structuredContent) {
      state = res.structuredContent;
      draft = cloneConfig(state.config);
      dirty = false;
    }
    toast = { text: '已保存，下次协作调用生效', kind: 'ok' };
  } catch (err) {
    toast = { text: `保存失败：${err?.message || err}`, kind: 'err' };
  } finally {
    saving = false;
    render();
  }
}

async function handleRefresh(projectDir, { refresh = true, silent = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  if (!silent) toast = { text: refresh ? '正在同步最新模型与用量…' : '正在读取项目交接…', kind: '' };
  render();
  try {
    const targetDir = projectDir ?? document.getElementById('inp-project-dir')?.value?.trim() ?? state?.project?.projectDir ?? '';
    const res = await app.callServerTool({
      name: 'load_project_status',
      arguments: { project_dir: targetDir || undefined, refresh },
    });
    if (res?.structuredContent) {
      state = res.structuredContent;
      if (!dirty) draft = cloneConfig(state.config);
      toast = { text: refresh ? '已更新最新额度与模型' : '已切换项目视图', kind: 'ok' };
    }
  } catch (err) {
    toast = { text: `刷新失败：${err?.message || err}`, kind: 'err' };
  } finally {
    refreshing = false;
    render();
  }
}

app.ontoolresult = (result) => {
  if (result?.structuredContent) {
    state = result.structuredContent;
    draft = cloneConfig(state.config);
    dirty = false;
    toast = { text: '就绪', kind: '' };
    render();
    const sampledAt = state.usage?.antigravity?.sampledAt;
    const stale = !sampledAt || (Date.now() - Date.parse(sampledAt) > 3 * 60 * 1000);
    if (stale && !autoRefreshedOnce) {
      autoRefreshedOnce = true;
      handleRefresh(undefined, { refresh: true, silent: true });
    }
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

await app.connect();
const ctx = app.getHostContext();
if (ctx?.theme) applyDocumentTheme(ctx.theme);
if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
