/* ══════════════════════════════════════════════
   CodeSentinel — app.js
   Depends on: Supabase JS v2 (loaded in index.html)
══════════════════════════════════════════════ */

'use strict';

// ── CONFIG ────────────────────────────────────
const CONFIG = {
  supabaseUrl:  'https://osfkbvoxedxvjkuffyxm.supabase.co',        // replace before deploy
  supabaseKey:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zZmtidm94ZWR4dmprdWZmeXhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5Nzg1ODEsImV4cCI6MjEwNzU1NDU4MX0.p1oP8FNqW3JiSePSilo2mDNEH7K1JsD7KgUhX__wv1k',   // replace before deploy
  backendUrl:   'https://code-sentinel-production.up.railway.app',         // e.g. https://your-api.railway.app
  themeKey:     'cs-theme',
};

// ── SUPABASE ──────────────────────────────────
const supabase = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

// ── STATE ─────────────────────────────────────
let state = {
  user:        null,
  session:     null,
  apiKeys:     [],        // { id, label, key_hash, key_preview, priority, is_active }
  patterns:    [],        // { pattern, severity, count }
  reviewCache: null,      // last review result
  inputMode:   'paste',   // 'paste' | 'upload'
  currentFile: null,      // { name, content }
  reviewing:   false,
  sidebarSection: 'sec-profile',
};

// ── DOM HELPERS ───────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

function show(id) { const el = $(id); if (el) el.hidden = false; }
function hide(id) { const el = $(id); if (el) el.hidden = true;  }
function setHtml(id, html) { const el = $(id); if (el) el.innerHTML = html; }
function setText(id, txt)  { const el = $(id); if (el) el.textContent = txt; }

// ══════════════════════════════════════════════
//   THEME
// ══════════════════════════════════════════════
function getTheme() {
  try { return localStorage.getItem(CONFIG.themeKey) || 'dark'; } catch { return 'dark'; }
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('themeToggle');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  try { localStorage.setItem(CONFIG.themeKey, t); } catch {}
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ══════════════════════════════════════════════
//   SCREEN ROUTING
// ══════════════════════════════════════════════
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.remove('visible'));
  const target = $(`screen-${name}`);
  if (target) target.classList.add('visible');

  // update nav tabs
  $$('.nav-tab[data-screen]').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.screen === name);
  });
}

// ══════════════════════════════════════════════
//   AUTH
// ══════════════════════════════════════════════
async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options:  { redirectTo: window.location.href.split('?')[0].split('#')[0] },
  });
  if (error) showLoginError(error.message);
}

async function signInWithEmail() {
  const email = $('emailInput').value.trim();
  const pass  = $('passwordInput').value;
  if (!email || !pass) { showLoginError('Enter email and password.'); return; }

  const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if (error) showLoginError(error.message);
}

async function signUp() {
  const email = $('emailInput').value.trim();
  const pass  = $('passwordInput').value;
  if (!email || !pass) { showLoginError('Enter email and password.'); return; }

  const { error } = await supabase.auth.signUp({ email, password: pass });
  if (error) showLoginError(error.message);
  else showLoginError('Check your email for a confirmation link.', 'info');
}

async function signOut() {
  await supabase.auth.signOut();
  state.user    = null;
  state.session = null;
  state.apiKeys = [];
  state.patterns = [];
  showScreen('login');
  updateNavAuth(null);
}

function showLoginError(msg, type = 'error') {
  const el = $('loginError');
  if (!el) return;
  el.textContent = msg;
  el.className   = type === 'info' ? 'hint-text' : 'field-error';
  el.hidden      = false;
}

function clearLoginError() {
  const el = $('loginError');
  if (el) el.hidden = true;
}

// ══════════════════════════════════════════════
//   SESSION INIT
// ══════════════════════════════════════════════
async function onAuthChange(session, event) {
  if (session?.user) {
    const wasLoggedOut = !state.user; // first login or page load
    state.user    = session.user;
    state.session = session;
    updateNavAuth(session.user);
    await Promise.all([loadApiKeys(), loadPatterns(), loadStats()]);
    // Only redirect to home on actual sign-in events, not token refreshes
    if (wasLoggedOut || event === 'SIGNED_IN') {
      showScreen('home');
    }
  } else {
    state.user    = null;
    state.session = null;
    updateNavAuth(null);
    showScreen('login');
  }
}

function updateNavAuth(user) {
  if (user) {
    show('navAvatar');
    show('navTabs');
    hide('navSignIn');
  } else {
    hide('navAvatar');
    hide('navTabs');
    show('navSignIn');
  }
}

// ══════════════════════════════════════════════
//   API KEYS
// ══════════════════════════════════════════════
async function loadApiKeys() {
  if (!state.user) return;
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, label, key_hash, key_preview, priority, is_active, created_at')
    .eq('user_id', state.user.id)
    .order('priority', { ascending: true });

  if (!error && data) {
    state.apiKeys = data;
    renderKeyTable();
    updateKeyStatus();
  }
}

function renderKeyTable() {
  const container = $('keyTable');
  if (!container) return;

  if (!state.apiKeys.length) {
    container.innerHTML = `<p class="hint-text" style="text-align:center;padding:16px">No API keys added yet.</p>`;
    return;
  }

  container.innerHTML = state.apiKeys.map((k, i) => `
    <div class="key-row" data-id="${k.id}">
      <div class="key-priority ${i === 0 ? 'p1' : ''}">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <div class="key-label">${escHtml(k.label || 'Key ' + (i + 1))}</div>
        <div class="key-preview">sk-or-••••••••${escHtml(k.key_preview)}</div>
      </div>
      <span class="key-status ${k.is_active ? 'ok' : 'warn'}">
        ${k.is_active ? 'Active' : 'Quota hit'}
      </span>
      <div class="key-actions">
        ${i > 0 ? `<button class="btn btn-ghost btn-sm" onclick="moveKey('${k.id}', -1)" title="Move up">↑</button>` : ''}
        ${i < state.apiKeys.length - 1 ? `<button class="btn btn-ghost btn-sm" onclick="moveKey('${k.id}', 1)" title="Move down">↓</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteKey('${k.id}')">Remove</button>
      </div>
    </div>
  `).join('');
}

function updateKeyStatus() {
  const dot  = $('keyStatusDot');
  const text = $('keyStatusText');
  if (!dot || !text) return;

  const active = state.apiKeys.filter(k => k.is_active);
  if (!state.apiKeys.length) {
    dot.className  = 'status-dot red';
    text.textContent = 'No keys';
  } else if (!active.length) {
    dot.className  = 'status-dot red';
    text.textContent = 'All keys exhausted';
  } else if (active.length < state.apiKeys.length) {
    dot.className  = 'status-dot yellow';
    text.textContent = `${active.length}/${state.apiKeys.length} keys active`;
  } else {
    dot.className  = 'status-dot green';
    text.textContent = `${active.length} key${active.length > 1 ? 's' : ''} ready`;
  }
}

function showAddKeyForm() {
  show('addKeyForm');
  $('newKeyValue')?.focus();
}

function hideAddKeyForm() {
  hide('addKeyForm');
  clearAddKeyForm();
}

function clearAddKeyForm() {
  const ki = $('newKeyValue');    if (ki) ki.value = '';
  const kl = $('newKeyLabel');    if (kl) kl.value = '';
  const kp = $('newKeyPriority'); if (kp) kp.value = '3';
  const ke = $('addKeyError');    if (ke) ke.hidden = true;
}

async function saveKey() {
  const raw      = $('newKeyValue')?.value.trim();
  const label    = $('newKeyLabel')?.value.trim() || 'My Key';
  const priority = parseInt($('newKeyPriority')?.value ?? '3', 10);

  if (!raw) { showKeyError('Enter an API key.'); return; }
  if (!raw.startsWith('sk-or-')) { showKeyError('Key must start with sk-or-'); return; }
  if (!state.user) { showKeyError('Not signed in.'); return; }

  const btnSave = $('btnSaveKey');
  if (btnSave) { btnSave.disabled = true; btnSave.textContent = 'Saving…'; }

  // Hash client-side — plaintext never sent to server
  const hash    = await sha256(raw);
  const preview = raw.slice(-4);

  const { error } = await supabase.from('api_keys').insert({
    user_id:     state.user.id,
    key_hash:    hash,
    key_preview: preview,
    label,
    is_active:   true,
    priority,
  });

  if (btnSave) { btnSave.disabled = false; btnSave.textContent = 'Save key'; }

  if (error) { showKeyError(error.message); return; }

  // Keep plaintext in sessionStorage for this browser session only
  sessionStorage.setItem(`key_${hash}`, raw);

  hideAddKeyForm();
  await loadApiKeys();
}

function showKeyError(msg) {
  const el = $('addKeyError');
  if (el) { el.textContent = msg; el.hidden = false; }
}

async function deleteKey(id) {
  showConfirm({
    title: 'Remove API key?',
    msg:   'This key will be permanently removed and cannot be recovered.',
    okLabel: 'Remove',
    onOk: async () => {
      await supabase.from('api_keys').delete().eq('id', id).eq('user_id', state.user.id);
      await loadApiKeys();
    },
  });
}

async function moveKey(id, dir) {
  const idx = state.apiKeys.findIndex(k => k.id === id);
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= state.apiKeys.length) return;

  const a = state.apiKeys[idx];
  const b = state.apiKeys[swapIdx];

  // Swap priorities
  await Promise.all([
    supabase.from('api_keys').update({ priority: b.priority }).eq('id', a.id),
    supabase.from('api_keys').update({ priority: a.priority }).eq('id', b.id),
  ]);
  await loadApiKeys();
}

// ══════════════════════════════════════════════
//   FILE UPLOAD
// ══════════════════════════════════════════════
const EXT_LANG = {
  py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript',
  tsx: 'typescript', java: 'java', cpp: 'cpp', cc: 'cpp', c: 'cpp',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', cs: 'csharp', kt: 'kotlin',
  swift: 'swift', sh: 'bash', bash: 'bash',
};

function setInputMode(mode) {
  state.inputMode = mode;
  $$('.input-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
  if (mode === 'paste') {
    show('mode-paste');
    hide('mode-file');
  } else {
    hide('mode-paste');
    show('mode-file');
  }
}

function handleFileSelect(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    state.currentFile = { name: file.name, content: e.target.result };
    setText('fileName', file.name);
    show('fileLoaded');

    const ext  = file.name.split('.').pop().toLowerCase();
    const lang = EXT_LANG[ext];
    if (lang) {
      const sel = $('langSelect');
      if (sel) sel.value = lang;
    }
  };
  reader.readAsText(file);
}

function clearFile() {
  state.currentFile = null;
  hide('fileLoaded');
  const fi = $('fileInput');
  if (fi) fi.value = '';
}

function initDropZone() {
  const zone = $('dropZone');
  if (!zone) return;

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelect(file);
  });
  zone.addEventListener('click', () => $('fileInput')?.click());

  $('fileInput')?.addEventListener('change', function () {
    handleFileSelect(this.files?.[0]);
  });
}

// ══════════════════════════════════════════════
//   CODE REVIEW
// ══════════════════════════════════════════════
async function runReview() {
  if (state.reviewing) return;

  const code = state.inputMode === 'upload'
    ? state.currentFile?.content
    : $('codeArea')?.value.trim();
  const lang = $('langSelect')?.value || 'auto';

  if (!code) { showReviewError('Paste some code or upload a file first.'); return; }
  if (!state.user) { showReviewError('Sign in to run a review.'); return; }

  const activeKeys = state.apiKeys.filter(k => k.is_active);
  if (!activeKeys.length) {
    showReviewError('Add an OpenRouter API key in Account → API Keys first.');
    return;
  }

  state.reviewing = true;
  hideResults();
  show('reviewLoading');
  hide('reviewError');

  const btn = $('btnRunReview');
  if (btn) btn.disabled = true;

  try {
    const result = await callReviewWithFailover(code, lang, activeKeys);
    displayResults(result);
  } catch (err) {
    showReviewError(err.message || 'Review failed. Please try again.');
  } finally {
    state.reviewing = false;
    hide('reviewLoading');
    if (btn) btn.disabled = false;
  }
}

async function callReviewWithFailover(code, lang, keys) {
  let lastError = null;

  for (const key of keys) {
    // Retrieve the actual key from session storage
    const raw = sessionStorage.getItem(`key_${key.key_hash}`);
    if (!raw) continue; // key not in this session, skip

    try {
      const result = await callBackendReview(code, lang, raw);
      // Mark key as active if it was previously inactive
      if (!key.is_active) {
        await supabase.from('api_keys').update({ is_active: true }).eq('id', key.id);
        key.is_active = true;
        updateKeyStatus();
      }
      return result;
    } catch (err) {
      lastError = err;
      // If quota/rate-limit error, mark key inactive and try next
      if (err.status === 429 || err.code === 'quota_exceeded') {
        await supabase.from('api_keys').update({ is_active: false }).eq('id', key.id);
        key.is_active = false;
        updateKeyStatus();
        continue;
      }
      // Other errors: rethrow immediately
      throw err;
    }
  }

  throw lastError || new Error('All API keys exhausted. Please add a new key.');
}

async function callBackendReview(code, lang, apiKey) {
  const token = state.session?.access_token;
  const res = await fetch(`${CONFIG.backendUrl}/review`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Api-Key':     apiKey,
    },
    body: JSON.stringify({ code, language: lang }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err  = new Error(data.detail || `HTTP ${res.status}`);
    err.status = res.status;
    err.code   = data.code;
    throw err;
  }

  return res.json();
}

function hideResults() {
  const el = $('resultsArea');
  if (el) el.hidden = true;
}

function displayResults(data) {
  hide('reviewLoading');
  hide('reviewError');

  const issues = data.issues || [];

  // Stats
  const crit = issues.filter(i => i.severity === 'critical').length;
  const warn = issues.filter(i => i.severity === 'warning').length;
  const info = issues.filter(i => i.severity === 'info').length;

  const pillsEl = $('statPills');
  if (pillsEl) {
    pillsEl.innerHTML = [
      { label: `${crit} Critical`, color: 'var(--red)',    dot: '#f85149' },
      { label: `${warn} Warning`,  color: 'var(--yellow)', dot: '#d29922' },
      { label: `${info} Info`,     color: 'var(--accent)', dot: '#388bfd' },
    ].map(s => `
      <span class="stat-pill">
        <span class="stat-dot" style="background:${s.dot}"></span>
        ${s.label}
      </span>
    `).join('');
  }

  const metaEl = $('resultsMeta');
  if (metaEl) {
    const cached = data.cached ? ' · <span class="badge badge-cached">cached</span>' : '';
    const ms     = data.latency_ms ? `${data.latency_ms}ms` : '';
    metaEl.innerHTML = [ms, data.model || ''].filter(Boolean).join(' · ') + cached;
  }

  // Issues list
  const listEl = $('issuesList');
  if (listEl) {
    if (!issues.length) {
      listEl.innerHTML = `
        <div class="issue info" style="align-items:center;flex-direction:row;gap:10px">
          <span style="font-size:20px">✅</span>
          <span style="font-size:13px;font-weight:600;color:var(--green)">No issues found — code looks clean!</span>
        </div>`;
    } else {
      listEl.innerHTML = issues.map(issue => {
        const sev   = issue.severity || 'info';
        const cls   = sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
        const label = sev === 'critical' ? 'Critical' : sev === 'warning' ? 'Warning' : 'Info';
        const title = escHtml(issue.title || issue.issue || 'Issue');
        const desc  = escHtml(issue.description || '');
        const fix   = escHtml(issue.fix || issue.suggestion || '');
        const line  = issue.line ? `<span class="issue-line">L${issue.line}</span>` : '';

        return `
          <div class="issue ${cls}">
            <div class="issue-top">
              <span class="badge badge-${cls}">${label}</span>
              <span class="issue-title">${title}</span>
              ${line}
            </div>
            ${desc ? `<p class="issue-desc">${desc}</p>` : ''}
            ${fix  ? `<code class="issue-fix">→ ${fix}</code>` : ''}
          </div>`;
      }).join('');
    }
  }

  state.reviewCache = data;
  show('resultsArea');
}

function showReviewError(msg) {
  hide('reviewLoading');
  setText('reviewErrorText', msg);
  show('reviewError');
}

// ══════════════════════════════════════════════
//   PROFILE / PATTERNS / STATS
// ══════════════════════════════════════════════
async function loadPatterns() {
  if (!state.user) return;
  const { data } = await supabase
    .from('patterns')
    .select('pattern, severity, count')
    .eq('user_id', state.user.id)
    .order('count', { ascending: false })
    .limit(20);

  state.patterns = data || [];
  renderPatterns();
}

function renderPatterns() {
  const container = $('patternList');
  if (!container) return;

  if (!state.patterns.length) {
    container.innerHTML = `<span class="hint-text">No patterns yet — run some reviews first.</span>`;
    return;
  }

  container.innerHTML = state.patterns.map(p => {
    const sev = p.severity || 'info';
    const cls = sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : '';
    return `<span class="p-chip ${cls}">${escHtml(p.pattern)} <strong>${p.count}</strong></span>`;
  }).join('');
}

// ── Profile helpers ───────────────────────────────
function getDisplayName(user) {
  const m = user?.user_metadata || {};
  // saved override wins; fall back to Google name then email prefix
  return m.display_name || m.full_name || m.name || user?.email?.split('@')[0] || 'User';
}

function getProfileInfo(user) {
  const m = user?.user_metadata || {};
  const type = m.info_type || 'course';
  if (type === 'none') return { label: null, val: null };
  const labels = { course: 'Course', section: 'Section', batch: 'Batch', branch: 'Branch' };
  const defaults = { course: 'CSE3005' };
  return {
    label: labels[type] || 'Info',
    val: m.info_value || defaults[type] || '—',
  };
}

function renderProfileCard(user) {
  const name = getDisplayName(user);
  const info = getProfileInfo(user);

  setText('profileName', name);
  setText('profileEmail', user.email || '—');
  setText('profileSince', user.created_at
    ? new Date(user.created_at).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—');

  // Info row — show or hide based on type
  const labelEl = $('profileInfoLabel');
  const valEl   = $('profileInfoVal');
  if (labelEl && valEl) {
    if (info.label) {
      labelEl.textContent = info.label;
      valEl.textContent   = info.val;
      labelEl.closest?.('div')?.removeAttribute('hidden');
    } else {
      labelEl.closest?.('div')?.setAttribute('hidden', '');
    }
  }

  // Avatars
  const userMeta = user.user_metadata || {};
  const pic = userMeta.avatar_url || userMeta.picture;
  [['profileAvatar', true], ['navAvatar', false]].forEach(([id, large]) => {
    const el = $(id);
    if (!el) return;
    if (pic) {
      el.innerHTML = `<img src="${pic}" style="width:100%;height:100%;border-radius:50%;object-fit:cover" alt="avatar">`;
    } else {
      el.textContent = name[0].toUpperCase();
    }
  });
}

async function loadStats() {
  if (!state.user) return;

  // ── Profile card ─────────────────────────────
  renderProfileCard(state.user);

  // ── Stats from Supabase ───────────────────────
  const { data } = await supabase
    .from('review_stats')
    .select('reviews_total, issues_found, cache_hits, cache_size_kb')
    .eq('user_id', state.user.id)
    .limit(1)
    .then(r => ({ data: r.data?.[0] ?? null, error: r.error }));

  const reviews   = data?.reviews_total ?? 0;
  const cacheHits = data?.cache_hits    ?? 0;
  const cacheRate = reviews > 0 ? Math.round((cacheHits / reviews) * 100) + '%' : '—';

  // Patterns section stats
  setText('statReviews',      reviews);
  setText('statPatterns',     state.patterns.length);
  setText('statCacheHit',     cacheRate);

  // Stats section
  setText('statTotalReviews', reviews);
  setText('statCacheRate',    cacheRate);
  setText('statAvgTime',      '—');
}

async function refreshPatterns() {
  await loadPatterns();
}

async function clearCache() {
  if (!state.user) return;
  showConfirm({
    title: 'Clear review cache?',
    msg:   'This removes all cached review results and cannot be undone.',
    okLabel: 'Clear cache',
    onOk: async () => {
      const token = state.session?.access_token;
      await fetch(`${CONFIG.backendUrl}/cache/clear`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      await loadStats();
    },
  });
}

async function clearProfile() {
  if (!state.user) return;
  showConfirm({
    title: 'Clear coding profile?',
    msg:   'All learned patterns will be lost. This cannot be undone.',
    okLabel: 'Clear profile',
    onOk: async () => {
      await supabase.from('patterns').delete().eq('user_id', state.user.id);
      state.patterns = [];
      renderPatterns();
    },
  });
}

async function deleteAccount() {
  if (!state.user) return;
  showConfirm({
    title: 'Delete account permanently?',
    msg:   'This removes your profile, patterns, and all saved keys. Type DELETE to confirm.',
    okLabel: 'Delete account',
    needsInput: true,
    inputPlaceholder: 'Type DELETE',
    inputMatch: 'DELETE',
    onOk: async () => {
      const token = state.session?.access_token;
      const res = await fetch(`${CONFIG.backendUrl}/account`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        await supabase.auth.signOut();
      } else {
        showConfirm({
          title: 'Deletion failed',
          msg: 'Account deletion failed. Try again or contact support.',
          okLabel: 'OK',
          okClass: 'btn-ghost',
          onOk: () => {},
        });
      }
    },
  });
}

// ══════════════════════════════════════════════
//   SIDEBAR NAVIGATION
// ══════════════════════════════════════════════
function sbNav(sectionId, btn) {
  $$('.sb-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.sidebarSection = sectionId;

  const target = document.getElementById(sectionId);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ══════════════════════════════════════════════
//   INLINE CONFIRM DIALOG
//   (replaces confirm()/prompt() — blocked in some browsers/iframes)
// ══════════════════════════════════════════════
function showConfirm({ title, msg, okLabel = 'Confirm', okClass = 'btn-danger',
                       needsInput = false, inputPlaceholder = 'Type here',
                       inputMatch = '', onOk }) {
  $('confirmTitle').textContent = title;
  $('confirmMsg').textContent   = msg;
  const okBtn = $('confirmOk');
  okBtn.textContent = okLabel;
  okBtn.className   = `btn ${okClass} btn-sm`;

  const wrap = $('confirmInputWrap');
  const inp  = $('confirmInput');
  if (needsInput) {
    wrap.hidden = false;
    inp.value = '';
    inp.placeholder = inputPlaceholder;
    inp.style.borderColor = '';
    setTimeout(() => inp.focus(), 80);
  } else {
    wrap.hidden = true;
  }
  $('confirmDialog').hidden = false;

  function close() { $('confirmDialog').hidden = true; }

  // Clone to remove any previous listeners
  const newOk     = okBtn.cloneNode(true);
  const newCancel = $('confirmCancel').cloneNode(true);
  okBtn.replaceWith(newOk);
  $('confirmCancel').replaceWith(newCancel);

  $('confirmCancel').addEventListener('click', close);
  $('confirmOk').addEventListener('click', () => {
    if (needsInput && inp.value.trim() !== inputMatch) {
      inp.style.borderColor = 'var(--red)';
      setTimeout(() => { inp.style.borderColor = ''; }, 600);
      return;
    }
    close();
    onOk();
  });
}

// ══════════════════════════════════════════════
//   UTILITIES
// ══════════════════════════════════════════════
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sha256(message) {
  const msgBuffer  = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ══════════════════════════════════════════════
//   PROFILE EDIT
// ══════════════════════════════════════════════
const INFO_LABELS = {
  course:  'Course code (e.g. CSE3005)',
  section: 'Section (e.g. S1)',
  batch:   'Batch / Year (e.g. 2023–27)',
  branch:  'Branch (e.g. B.Tech CSE)',
};

function openEditProfileModal() {
  if (!state.user) return;
  const m = state.user.user_metadata || {};

  // Pre-fill display name
  const nameInput = $('editDisplayName');
  if (nameInput) nameInput.value = m.display_name || m.full_name || m.name || '';

  // Pre-select radio
  const currentType = m.info_type || 'course';
  const radio = document.querySelector(`input[name="profileInfoType"][value="${currentType}"]`);
  if (radio) radio.checked = true;

  // Pre-fill info value
  const infoInput = $('editProfileInfo');
  if (infoInput) infoInput.value = m.info_value || '';

  // Show/hide info input based on current type
  updateInfoInputVisibility(currentType);

  clearEditProfileError();
  $('editProfileModal').hidden = false;
}

function closeEditProfileModal() {
  $('editProfileModal').hidden = true;
}

function updateInfoInputVisibility(type) {
  const wrap  = $('profileInfoInputWrap');
  const label = $('profileInfoInputLabel');
  if (!wrap) return;
  if (type === 'none') {
    wrap.hidden = true;
  } else {
    wrap.hidden = false;
    if (label) label.textContent = INFO_LABELS[type] || 'Value';
    const inp = $('editProfileInfo');
    if (inp) inp.placeholder = INFO_LABELS[type]?.split('(')[1]?.replace(')', '') || '';
  }
}

function showEditProfileError(msg) {
  const el = $('editProfileError');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}
function clearEditProfileError() {
  const el = $('editProfileError');
  if (el) el.hidden = true;
}

async function saveProfile() {
  if (!state.user) return;
  clearEditProfileError();

  const displayName = $('editDisplayName')?.value.trim() || '';
  const infoType    = document.querySelector('input[name="profileInfoType"]:checked')?.value || 'course';
  const infoValue   = $('editProfileInfo')?.value.trim() || '';

  const btn = $('btnSaveProfile');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const { data, error } = await supabase.auth.updateUser({
      data: {
        display_name: displayName || null,
        info_type:    infoType,
        info_value:   infoType === 'none' ? null : (infoValue || null),
      },
    });

    if (error) {
      console.error('saveProfile error:', error);
      showEditProfileError(error.message || 'Could not save — try again.');
      return;
    }

    // Update local state with fresh user metadata
    if (data?.user) {
      state.user = data.user;
      if (state.session) state.session.user = data.user;
    }

    renderProfileCard(state.user);
    closeEditProfileModal();
  } catch (err) {
    console.error('saveProfile exception:', err);
    showEditProfileError('Unexpected error — check the console.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// ══════════════════════════════════════════════
//   EVENT WIRING
// ══════════════════════════════════════════════
function wireEvents() {
  // Theme
  $('themeToggle')?.addEventListener('click', toggleTheme);

  // Nav — screen switching
  $$('.nav-tab[data-screen]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (!state.user && tab.dataset.screen !== 'login') return;
      showScreen(tab.dataset.screen);
    });
  });

  $('navSignIn')?.addEventListener('click', () => showScreen('login'));
  $('navAvatar')?.addEventListener('click', () => showScreen('account'));

  // Login
  $('btnGoogleSignIn')?.addEventListener('click', signInWithGoogle);
  $('btnEmailSignIn')?.addEventListener('click',  signInWithEmail);
  $('btnSignUp')?.addEventListener('click', signUp);
  $$('#screen-login input').forEach(inp => {
    inp.addEventListener('input', clearLoginError);
  });

  // Account — sign out / danger
  $('btnSignOut')?.addEventListener('click', signOut);
  $('btnDeleteAccount')?.addEventListener('click', deleteAccount);
  $('btnClearCache')?.addEventListener('click', clearCache);
  $('btnClearProfile')?.addEventListener('click', clearProfile);
  $('btnRefreshPatterns')?.addEventListener('click', refreshPatterns);

  // Edit profile modal
  $('btnEditProfile')?.addEventListener('click', openEditProfileModal);
  $('btnCloseEditProfile')?.addEventListener('click', closeEditProfileModal);
  $('btnCancelEditProfile')?.addEventListener('click', closeEditProfileModal);
  $('btnSaveProfile')?.addEventListener('click', saveProfile);
  $('editProfileModal')?.addEventListener('click', e => {
    if (e.target === $('editProfileModal')) closeEditProfileModal();
  });

  // Radio change → show/hide info input
  document.querySelectorAll('input[name="profileInfoType"]').forEach(radio => {
    radio.addEventListener('change', () => updateInfoInputVisibility(radio.value));
  });

  // API keys
  $('btnShowAddKey')?.addEventListener('click', showAddKeyForm);
  $('btnSaveKey')?.addEventListener('click', saveKey);
  $('btnCancelKey')?.addEventListener('click', hideAddKeyForm);

  // Home — input mode tabs
  $$('.input-tab[data-mode]').forEach(tab => {
    tab.addEventListener('click', () => setInputMode(tab.dataset.mode));
  });

  // Home — file clear
  $('btnClearFile')?.addEventListener('click', clearFile);

  // Home — run review
  $('btnRunReview')?.addEventListener('click', runReview);
  $('codeArea')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runReview();
  });

  // Sidebar nav wiring — read data-section from each button
  $$('.sb-item[data-section]').forEach(btn => {
    btn.addEventListener('click', () => sbNav(btn.dataset.section, btn));
  });
}

// ══════════════════════════════════════════════
//   BOOT
// ══════════════════════════════════════════════
async function init() {
  // Apply saved theme immediately
  applyTheme(getTheme());

  // Wire all event handlers
  wireEvents();

  // Init drop zone
  initDropZone();

  // Listen for auth state changes
  supabase.auth.onAuthStateChange((event, session) => {
    onAuthChange(session, event);
  });

  // Get current session (handles OAuth redirect)
  const { data: { session } } = await supabase.auth.getSession();
  await onAuthChange(session);
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}