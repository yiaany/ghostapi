// DOM References
const els = {
  sidebar: document.getElementById('sidebar'),
  toggleBtn: document.getElementById('sidebar-toggle'),
  statusIndicator: document.getElementById('status-indicator'),
  statusText: document.getElementById('status-text'),
  eventList: document.getElementById('event-list'),
  eventCount: document.getElementById('event-count'),
  emptyDetails: document.getElementById('empty-details'),
  detailsContent: document.getElementById('details-content'),
  searchModal: document.getElementById('search-modal'),
  searchInput: document.getElementById('search-input'),
  rulesModal: document.getElementById('rules-modal'),
  rulesOutput: document.getElementById('rules-output'),
  rulesSubtitle: document.getElementById('rules-subtitle'),
  setupModal: document.getElementById('setup-modal'),
  setupList: document.getElementById('setup-list'),
  setupOutput: document.getElementById('setup-output'),
  setupSubtitle: document.getElementById('setup-subtitle'),
  scenariosModal: document.getElementById('scenarios-modal'),
  scenarioList: document.getElementById('scenario-list'),
  scenarioOutput: document.getElementById('scenario-output'),
  scenariosSubtitle: document.getElementById('scenarios-subtitle'),
  dMethod: document.getElementById('d-method'),
  dPath: document.getElementById('d-path'),
  dStatus: document.getElementById('d-status'),
  dTime: document.getElementById('d-time'),
  dProvider: document.getElementById('d-provider'),
  dSource: document.getElementById('d-source'),
  dReq: document.getElementById('d-req-body'),
  dRes: document.getElementById('d-res-body'),
  faultToggle: document.getElementById('fault-toggle'),
  faultState: document.getElementById('fault-state'),
};

let events = [];
let activeId = null;
let currentFilter = 'all';
let setupPayload = null;
let selectedSetupText = '';
let scenarios = [];

// Initialize
async function init() {
  setupInteractions();
  await fetchFaultLab();
  await fetchHistory();
  setupSSE();
}

// Side-effects & Listeners
function setupInteractions() {
  els.toggleBtn.onclick = () => els.sidebar.classList.toggle('closed');

  // Command + K
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      openSearch();
    }
    if (e.key === 'Escape') closeSearch();
    if (e.key === 'Escape') closeRulesModal();
    if (e.key === 'Escape') closeSetupModal();
    if (e.key === 'Escape') closeScenariosModal();
  });

  // Modal overlay click
  els.searchModal.onclick = (e) => {
    if (e.target === els.searchModal) closeSearch();
  };
  els.rulesModal.onclick = (e) => {
    if (e.target === els.rulesModal) closeRulesModal();
  };
  els.setupModal.onclick = (e) => {
    if (e.target === els.setupModal) closeSetupModal();
  };
  els.scenariosModal.onclick = (e) => {
    if (e.target === els.scenariosModal) closeScenariosModal();
  };

  els.searchInput.addEventListener('input', renderList);
}

function openSearch() {
  els.searchModal.classList.add('open');
  els.searchInput.focus();
}

function closeSearch() {
  els.searchModal.classList.remove('open');
  els.searchInput.value = '';
  renderList();
}

// Data Handling
async function fetchHistory() {
  try {
    const res = await fetch('/api/events');
    const data = await res.json();
    events = data.reverse();
    renderList();
  } catch(e) {}
}

function setupSSE() {
  const sse = new EventSource('/events');
  sse.onopen = () => {
    els.statusIndicator.className = 'status-indicator connected';
    els.statusText.textContent = 'Connected';
  };
  sse.onerror = () => {
    els.statusIndicator.className = 'status-indicator error';
    els.statusText.textContent = 'Reconnecting...';
  };
  sse.onmessage = (e) => {
    const payload = JSON.parse(e.data);
    if (payload.type === 'proxy_event') {
      events.unshift(payload.event);
      if (events.length > 200) events.pop();
      renderList();
    }
  };
}

// Filter Management
window.setFilter = (filter) => {
  currentFilter = filter;
  document.querySelectorAll('.nav-scroll-area .nav-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.getElementById('nav-' + filter);
  if (activeEl) activeEl.classList.add('active');
  
  if (filter === 'all') {
    document.querySelector('.breadcrumb-active').textContent = 'Live Traffic';
  } else {
    document.querySelector('.breadcrumb-active').textContent = activeEl.querySelector('.nav-item-title').textContent + ' Routing';
  }
  
  renderList();
};

window.clearStorage = async (target, event) => {
  try {
    const btnText = event.currentTarget.querySelector('.nav-item-title');
    const originalText = btnText.textContent;
    btnText.textContent = 'Clearing...';

    await fetch('/api/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target })
    });

    btnText.textContent = 'Cleared!';
    setTimeout(() => { btnText.textContent = originalText; }, 1500);
  } catch(e) {
    console.error(e);
  }
};

async function fetchFaultLab() {
  try {
    const res = await fetch('/api/fault-lab');
    renderFaultLab(await res.json());
  } catch(e) {}
}

window.toggleFaultLab = async (event) => {
  const label = event.currentTarget.querySelector('.nav-item-title');
  const original = label.textContent;
  try {
    const enabled = !els.faultToggle.classList.contains('active');
    label.textContent = enabled ? 'Arming...' : 'Disarming...';

    const res = await fetch('/api/fault-lab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, latencyMs: 0, latencyMinMs: 2000, latencyMaxMs: 5000, errorRate: enabled ? 15 : 15, statusCode: 429, retryAfterSeconds: 2 })
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error?.message || 'Unable to toggle Chaos Mode');
    renderFaultLab(payload);
  } catch(e) {
    console.error(e);
  } finally {
    label.textContent = original;
  }
};

function renderFaultLab(config) {
  els.faultToggle.classList.toggle('active', config.enabled);
  els.faultState.textContent = config.enabled ? `${config.errorRate}%` : 'Off';
}

window.generateAiRules = async (event) => {
  const label = event.currentTarget.querySelector('.nav-item-title');
  const original = label.textContent;
  label.textContent = 'Generating...';
  els.rulesModal.classList.add('open');
  els.rulesOutput.textContent = 'Generating .cursorrules from package.json...';
  els.rulesSubtitle.textContent = 'Scanning dependencies';

  try {
    const res = await fetch('/api/ai-rules', { method: 'POST' });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error?.message || 'Unable to generate AI rules');
    els.rulesOutput.textContent = payload.content;
    els.rulesSubtitle.textContent = payload.detected.length > 0 ? `Detected: ${payload.detected.join(', ')}` : 'No known provider SDKs detected';
  } catch (e) {
    els.rulesOutput.textContent = `# GhostAPI Agent Rules\n\nGeneration failed: ${e.message}`;
    els.rulesSubtitle.textContent = 'Generation failed';
  } finally {
    label.textContent = original;
  }
};

window.copyAgentPrompt = async (event) => {
  const label = event.currentTarget.querySelector('.nav-item-title');
  const original = label.textContent;
  label.textContent = 'Copying...';
  try {
    const res = await fetch('/api/agent-prompt');
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error?.message || 'Unable to generate prompt');
    await copyText(payload.content);
    els.rulesModal.classList.add('open');
    els.rulesSubtitle.textContent = 'Copied to clipboard';
    els.rulesOutput.textContent = payload.content;
  } catch (e) {
    els.rulesModal.classList.add('open');
    els.rulesSubtitle.textContent = 'Prompt generation failed';
    els.rulesOutput.textContent = `GhostAPI agent prompt failed: ${e.message}`;
  } finally {
    label.textContent = original;
  }
};

window.openSafetyReport = async (event) => {
  const label = event.currentTarget.querySelector('.nav-item-title');
  const original = label.textContent;
  label.textContent = 'Scanning...';
  els.rulesModal.classList.add('open');
  els.rulesSubtitle.textContent = 'Scanning repo';
  els.rulesOutput.textContent = 'Generating GhostAPI safety report...';
  try {
    const res = await fetch('/api/safety-report');
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error?.message || 'Unable to generate safety report');
    els.rulesSubtitle.textContent = `${payload.findings.length} findings`;
    els.rulesOutput.textContent = formatSafetyReport(payload);
  } catch (e) {
    els.rulesSubtitle.textContent = 'Safety report failed';
    els.rulesOutput.textContent = `Safety report failed: ${e.message}`;
  } finally {
    label.textContent = original;
  }
};

function closeRulesModal() {
  els.rulesModal.classList.remove('open');
}

function copyRules() {
  copyText(els.rulesOutput.textContent);
}

window.generateRepoSetup = async (event) => {
  const label = event.currentTarget.querySelector('.nav-item-title');
  const original = label.textContent;
  label.textContent = 'Generating...';
  selectedSetupText = '';
  setupPayload = null;
  els.setupModal.classList.add('open');
  els.setupList.innerHTML = '';
  els.setupOutput.textContent = 'Scanning package.json and building Cursor/Cline/Claude setup...';
  els.setupSubtitle.textContent = 'Scanning this repo';

  try {
    const res = await fetch('/api/setup', { method: 'POST' });
    setupPayload = await res.json();
    if (!res.ok) throw new Error(setupPayload?.error?.message || 'Unable to generate setup');
    renderSetup(setupPayload);
  } catch (e) {
    els.setupOutput.textContent = `Setup generation failed: ${e.message}`;
    els.setupSubtitle.textContent = 'Generation failed';
  } finally {
    label.textContent = original;
  }
};

function renderSetup(setup) {
  els.setupSubtitle.textContent = setup.detected.length > 0 ? `Detected SDKs: ${setup.detected.join(', ')}` : 'No known SDKs detected';
  els.setupList.innerHTML = '';

  addSetupItem('Summary', setup.summary);
  addSetupItem('Commands', setup.commands.join('\n'));
  for (const file of setup.files) addSetupItem(file.path, file.content, file.description);
  for (const patch of setup.patches) addSetupItem(patch.title, patch.content, patch.appliesTo);

  selectSetupText('Summary', setup.summary);
}

function addSetupItem(title, content, description = '') {
  const button = document.createElement('button');
  button.className = 'setup-item';
  button.type = 'button';
  button.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(description || 'Copy-ready setup block')}</span>`;
  button.onclick = () => selectSetupText(title, content);
  els.setupList.appendChild(button);
}

function selectSetupText(title, content) {
  selectedSetupText = content;
  els.setupOutput.textContent = content;
  els.setupList.querySelectorAll('.setup-item').forEach((item) => item.classList.toggle('active', item.querySelector('strong')?.textContent === title));
}

function closeSetupModal() {
  els.setupModal.classList.remove('open');
}

function copySetupOutput() {
  copyText(selectedSetupText || els.setupOutput.textContent);
}

window.openScenarios = async (event) => {
  const label = event.currentTarget.querySelector('.nav-item-title');
  const original = label.textContent;
  label.textContent = 'Loading...';
  scenarios = [];
  els.scenariosModal.classList.add('open');
  els.scenarioList.textContent = '';
  els.scenarioOutput.textContent = 'Loading scenario presets...';
  els.scenariosSubtitle.textContent = 'Loading presets';

  try {
    const res = await fetch('/api/scenarios');
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error?.message || 'Unable to load scenarios');
    scenarios = payload;
    renderScenarios();
  } catch (e) {
    els.scenarioOutput.textContent = `Unable to load scenarios: ${e.message}`;
  } finally {
    label.textContent = original;
  }
};

function renderScenarios() {
  els.scenarioList.innerHTML = '';
  els.scenariosSubtitle.textContent = `${scenarios.length} presets ready`;
  const saveCard = document.createElement('div');
  saveCard.className = 'scenario-card scenario-save-card';
  const saveTitle = document.createElement('strong');
  saveTitle.textContent = 'Save current traffic';
  const saveDescription = document.createElement('p');
  saveDescription.textContent = 'Turn the latest dashboard traffic into a replayable custom scenario.';
  const saveActions = document.createElement('div');
  saveActions.className = 'scenario-actions';
  saveActions.append(scenarioButton('Save', saveTrafficScenario));
  saveCard.append(saveTitle, saveDescription, saveActions);
  els.scenarioList.appendChild(saveCard);
  for (const scenario of scenarios) {
    const card = document.createElement('div');
    card.className = 'scenario-card';
    const top = document.createElement('div');
    top.className = 'scenario-card-top';
    const title = document.createElement('strong');
    title.textContent = scenario.title;
    const provider = document.createElement('span');
    provider.className = 'pill';
    provider.textContent = scenario.provider;
    top.append(title, provider);

    const description = document.createElement('p');
    description.textContent = scenario.description;

    const actions = document.createElement('div');
    actions.className = 'scenario-actions';
    actions.append(
      scenarioButton('Replay', () => replayScenario(scenario.id)),
      scenarioButton('Export', () => exportScenario(scenario.id)),
      scenarioButton('Share', () => shareScenario(scenario.id))
    );

    card.append(top, description, actions);
    els.scenarioList.appendChild(card);
  }
  els.scenarioOutput.textContent = JSON.stringify(scenarios[0] ?? {}, null, 2);
}

window.replayScenario = async (id) => {
  const payload = await fetchScenarioAction(`/api/scenarios/${encodeURIComponent(id)}/replay`, { method: 'POST' });
  const text = JSON.stringify(payload, null, 2);
  els.scenarioOutput.textContent = text;
  await copyText(text);
};

window.exportScenario = async (id) => {
  const payload = await fetchScenarioAction(`/api/scenarios/${encodeURIComponent(id)}/export`);
  const text = JSON.stringify(payload, null, 2);
  els.scenarioOutput.textContent = text;
  await copyText(text);
};

window.shareScenario = async (id) => {
  const payload = await fetchScenarioAction(`/api/scenarios/${encodeURIComponent(id)}/share`, { method: 'POST' });
  els.scenarioOutput.textContent = JSON.stringify(payload, null, 2);
  await copyText(payload.shareText || JSON.stringify(payload));
};

async function saveTrafficScenario() {
  const payload = await fetchScenarioAction('/api/scenarios/save-from-traffic', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `Saved traffic ${new Date().toLocaleString()}` })
  });
  const text = JSON.stringify(payload, null, 2);
  els.scenarioOutput.textContent = text;
  await copyText(text);
  const res = await fetch('/api/scenarios');
  scenarios = await res.json();
}

function scenarioButton(label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.onclick = () => handler().catch((error) => {
    els.scenarioOutput.textContent = `Scenario action failed: ${error.message}`;
  });
  return button;
}

async function fetchScenarioAction(url, options) {
  const res = await fetch(url, options);
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error?.message || 'Scenario action failed');
  return payload;
}

function closeScenariosModal() {
  els.scenariosModal.classList.remove('open');
}

// Render Logic
function renderList() {
  const query = els.searchInput.value.toLowerCase();
  const list = events.filter(e => {
    const path = String(e.path ?? '');
    const provider = String(e.provider ?? '');
    const requestText = safeStringify(e.request).toLowerCase();
    const matchesSearch = path.toLowerCase().includes(query) || 
                          provider.toLowerCase().includes(query) ||
                          requestText.includes(query);
    const matchesFilter = currentFilter === 'all' || provider === currentFilter;
    return matchesSearch && matchesFilter;
  });

  els.eventCount.textContent = events.length;
  els.eventList.innerHTML = '';

  const frag = document.createDocumentFragment();
  list.forEach(ev => {
    const div = document.createElement('div');
    div.className = `event-card ${ev.id === activeId ? 'active' : ''}`;
    div.onclick = () => selectEvent(ev.id);

    const method = String(ev.method ?? 'GET');
    const statusCode = Number(ev.statusCode ?? 0);
    const top = document.createElement('div');
    top.className = 'ec-top';
    const methodEl = document.createElement('span');
    methodEl.className = `ec-method m-${method.toLowerCase()}`;
    methodEl.textContent = method;
    const time = document.createElement('span');
    time.className = 'ec-time';
    time.textContent = new Date(ev.timestamp ?? Date.now()).toLocaleTimeString();
    top.append(methodEl, time);

    const path = document.createElement('div');
    path.className = 'ec-path';
    path.textContent = String(ev.path ?? '');

    const bottom = document.createElement('div');
    bottom.className = 'ec-bottom';
    const status = document.createElement('span');
    status.className = `pill pill-status-${strType(statusCode)}`;
    status.textContent = String(statusCode || 'n/a');
    const duration = document.createElement('span');
    duration.className = 'pill';
    duration.textContent = `${Number(ev.durationMs ?? 0)}ms`;
    const provider = document.createElement('span');
    provider.className = 'pill provider-pill';
    provider.textContent = String(ev.provider ?? 'unknown');
    bottom.append(status, duration, provider);

    div.append(top, path, bottom);
    frag.appendChild(div);
  });
  els.eventList.appendChild(frag);
}

function selectEvent(id) {
  activeId = id;
  renderList();
  const ev = events.find(e => e.id === id);
  if (!ev) return;

  els.emptyDetails.style.display = 'none';
  els.detailsContent.classList.add('visible');

  els.dMethod.textContent = ev.method;
  els.dMethod.className = `ec-method m-${ev.method.toLowerCase()}`;
  els.dPath.textContent = ev.path;
  
  els.dStatus.textContent = ev.statusCode;
  els.dStatus.className = `pill pill-status-${strType(ev.statusCode)}`;
  
  els.dTime.textContent = `${ev.durationMs}ms`;
  els.dProvider.textContent = ev.provider;
  els.dSource.textContent = ev.source;

  els.dReq.innerHTML = highlight(ev.request);
  els.dRes.innerHTML = highlight(ev.response);
}

window.generateSelectedTest = async () => {
  if (!activeId) return;
  try {
    const res = await fetch(`/api/events/${encodeURIComponent(activeId)}/test`);
    const payload = await res.json();
    if (!res.ok) throw new Error(payload?.error?.message || 'Unable to generate test');
    els.rulesModal.classList.add('open');
    els.rulesSubtitle.textContent = payload.filename;
    els.rulesOutput.textContent = payload.content;
    await copyText(payload.content);
  } catch (e) {
    els.rulesModal.classList.add('open');
    els.rulesSubtitle.textContent = 'Test generation failed';
    els.rulesOutput.textContent = `Test generation failed: ${e.message}`;
  }
};

// Utils
function strType(code) {
  if (code >= 200 && code < 300) return '200';
  if (code >= 300 && code < 400) return '300';
  if (code >= 400 && code < 500) return '400';
  return '500';
}

function highlight(obj) {
  if (!obj) return '{}';
  const str = JSON.stringify(obj, null, 2);
  const scaped = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return scaped.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    let cls = 'j-num';
    if (/^"/.test(match)) { cls = /:$/.test(match) ? 'j-key' : 'j-str'; }
    else if (/true|false/.test(match)) cls = 'j-bool';
    else if (/null/.test(match)) cls = 'j-null';
    return `<span class="${cls}">${match}</span>`;
  });
}

function copy(type) {
  const text = (type === 'req') ? els.dReq.textContent : els.dRes.textContent;
  copyText(text);
}

window.closeRulesModal = closeRulesModal;
window.copyRules = copyRules;
window.closeSetupModal = closeSetupModal;
window.copySetupOutput = copySetupOutput;
window.closeScenariosModal = closeScenariosModal;

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSafetyReport(report) {
  const findings = report.findings.length > 0
    ? report.findings.map((finding) => `- ${finding.severity.toUpperCase()} ${finding.file ? `${finding.file}: ` : ''}${finding.message}`).join('\n')
    : '- No high-risk provider usage found.';
  return [
    '# GhostAPI Safety Report',
    '',
    `Project: ${report.projectRoot}`,
    `Detected SDKs: ${report.detected.length > 0 ? report.detected.join(', ') : 'none'}`,
    '',
    '## Findings',
    findings,
    '',
    '## Recommendations',
    ...report.recommendations.map((item) => `- ${item}`)
  ].join('\n');
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text ?? '');
  } catch (error) {
    console.warn('Clipboard copy failed', error);
  }
}

init();
