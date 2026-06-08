// js/app.js
import { requireAuth, logout } from './auth.js';
import {
  getPatients, addPatient, updatePatient, deletePatient,
  getLatestEventsAll, getAllEvents,
  getAlerts, createAlert, clearAlerts
} from './db.js';

// ─── State ────────────────────────────────────────────────────
let patients = [];
let alerts   = [];
let latestEvents = {};
let activeFilter = 'todos';
let searchQuery  = '';
let pollingTimer = null;

// ─── Theme ────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('vg_theme');
  const dark  = saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  updateThemeIcon(dark);
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  localStorage.setItem('vg_theme', isDark ? 'light' : 'dark');
  updateThemeIcon(!isDark);
  const t = document.getElementById('dark-toggle');
  if (t) t.checked = !isDark;
}
function updateThemeIcon(isDark) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.innerHTML = isDark
    ? `<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.22 3.22l1.06 1.06M11.72 11.72l1.06 1.06M3.22 12.78l1.06-1.06M11.72 4.28l1.06-1.06" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`
    : `<svg viewBox="0 0 16 16" fill="none"><path d="M13.5 10A6 6 0 0 1 6 2.5a6 6 0 1 0 7.5 7.5z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
}

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();

  const user = await requireAuth();
  if (!user) return;

  const uel = document.getElementById('user-email');
  const sel = document.getElementById('settings-email');
  if (uel) uel.textContent = user.email;
  if (sel) sel.textContent = user.email;

  await loadAll();

  // Nav
  document.querySelectorAll('[data-screen]').forEach(btn => {
    btn.addEventListener('click', () => goTo(btn.dataset.screen));
  });

  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  document.getElementById('tr-search')?.addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    applyFilter();
  });
  document.querySelectorAll('[data-filter]').forEach(c => {
    c.addEventListener('click', () => setFilter(c));
  });
  document.getElementById('add-form')?.addEventListener('submit', handleAddPatient);
  document.getElementById('clear-btn')?.addEventListener('click', clearForm);
  document.getElementById('bell-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('notif-panel')?.classList.toggle('show');
  });
  document.getElementById('notif-clear')?.addEventListener('click', handleClearAlerts);
  document.addEventListener('click', () => document.getElementById('notif-panel')?.classList.remove('show'));
  document.querySelectorAll('.logout-trigger').forEach(b => b.addEventListener('click', logout));
  document.getElementById('export-btn')?.addEventListener('click', exportCSV);

  initSettings();

  // Request browser notification permission
  requestNotifPermission();

  // Start polling when on realtime screen
  startPolling();
});

// ─── Polling ─────────────────────────────────────────────────
function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    // Always fetch latest events and check for alerts, regardless of screen
    try { latestEvents = await getLatestEventsAll(); } catch(e) {}
    await checkForNewAlerts();

    if (document.getElementById('screen-realtime')?.classList.contains('active')) {
      renderRealtimeTable();
    }
    if (document.getElementById('screen-home')?.classList.contains('active')) {
      await loadAll();
      renderHome();
    }
  }, 10000);
}

async function loadAll() {
  try { patients     = await getPatients(); }      catch(e) { console.error(e); }
  try { latestEvents = await getLatestEventsAll(); } catch(e) { console.error(e); }
  try { alerts       = await getAlerts(); renderAlerts(); } catch(e) { console.error(e); }
}

// ─── Navigation ───────────────────────────────────────────────
const screenMeta = {
  home:       { title: 'Painel de controlo' },
  realtime:   { title: 'Tempo real'         },
  registos:   { title: 'Registos'           },
  adicionar:  { title: 'Adicionar utente'   },
  perfil:     { title: 'Perfil do utente'   },
  definicoes: { title: 'Definições'         },
};

export function goTo(name) {
  document.querySelectorAll('[data-screen]').forEach(b =>
    b.classList.toggle('active', b.dataset.screen === name)
  );
  document.querySelectorAll('.screen').forEach(s =>
    s.classList.toggle('active', s.id === 'screen-' + name)
  );
  const title = screenMeta[name]?.title || name;
  const ttl = document.getElementById('topbar-title');
  if (ttl) ttl.textContent = title;

  if (name === 'home')     renderHome();
  if (name === 'realtime') renderRealtimeTable();
  if (name === 'registos') renderRegistos();
}

// ─── Home ─────────────────────────────────────────────────────
async function renderHome() {
  let ok = 0, warn = 0, crit = 0;
  patients.forEach(p => {
    const s = getStatus(latestEvents[p.id]);
    if (s === 'ok') ok++;
    else if (s === 'warn') warn++;
    else if (s === 'crit') crit++;
  });

  const el = id => document.getElementById(id);
  if (el('stat-total'))  el('stat-total').textContent  = patients.length;
  if (el('stat-ok'))     el('stat-ok').textContent     = ok;
  if (el('stat-warn'))   el('stat-warn').textContent   = warn;
  if (el('stat-crit'))   el('stat-crit').textContent   = crit;

  const list = el('recent-patients');
  if (!list) return;
  list.innerHTML = '';
  patients.slice(0, 6).forEach(p => {
    const ev     = latestEvents[p.id] || null;
    const s      = getStatus(ev);
    const colors = avatarColors(p.id);
    list.innerHTML += `
      <div class="patient-row" onclick="goTo('realtime')">
        <div class="avatar" style="background:${colors.bg};color:${colors.fg}">${getInitials(p.name)}</div>
        <div>
          <div class="p-name">${p.name}</div>
          <div class="p-sub">${ev ? stateLabel(ev.alert_state) : 'Sem dados'}</div>
        </div>
        <span class="badge badge-${s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'alert'}">
          ${s === 'ok' ? 'Normal' : s === 'warn' ? 'Atenção' : 'Alerta'}
        </span>
      </div>`;
  });
  if (!patients.length) list.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:16px 0">Sem utentes registados.</div>';
}

// ─── Alerts ───────────────────────────────────────────────────
function renderAlerts() {
  const panel  = document.getElementById('notif-list');
  const badge  = document.getElementById('bell-badge');
  const header = document.getElementById('notif-count');
  const homeEl = document.getElementById('home-alerts');

  const unresolved = alerts.filter(a => !a.resolved);

  if (!unresolved.length) {
    if (panel)  panel.innerHTML  = '<div class="notif-empty">Sem alertas activos.</div>';
    if (badge)  badge.style.display = 'none';
    if (header) header.textContent  = 'Notificações';
    if (homeEl) homeEl.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:8px 0">Sem alertas.</div>';
    return;
  }

  if (badge)  badge.style.display = 'block';
  if (header) header.textContent  = `Notificações (${unresolved.length})`;
  if (homeEl) homeEl.innerHTML = '';
  if (panel)  panel.innerHTML  = '';

  unresolved.slice(0, 8).forEach(a => {
    const isRed = a.type === 'red';
    const time  = new Date(a.created_at).toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });
    const html  = `
      <div class="alert-item">
        <div class="alert-dot ${isRed ? 'dot-alert' : 'dot-warn'}"></div>
        <div><div class="alert-txt">${a.patients?.name || 'Utente'} — ${a.message}</div></div>
        <div class="alert-time">${time}</div>
      </div>`;
    if (homeEl) homeEl.innerHTML += html;
    if (panel)  panel.innerHTML  += `
      <div class="notif-item">
        <div class="alert-dot ${isRed ? 'dot-alert' : 'dot-warn'}" style="margin-top:4px"></div>
        <div><div class="notif-txt">${a.patients?.name || 'Utente'} — ${a.message}</div>
        <div class="notif-sub">${time}</div></div>
      </div>`;
  });
}

async function handleClearAlerts() {
  try { await clearAlerts(); alerts = []; renderAlerts(); showToast('Alertas limpos.'); }
  catch(e) { showToast('Erro ao limpar alertas.', 'error'); }
}

// ─── Alert popup + sound ─────────────────────────────────────
// Track which event IDs we've already alerted on to avoid duplicates
const alertedEventIds = new Set(JSON.parse(localStorage.getItem('vg_alerted') || '[]'));

function saveAlertedIds() {
  // Keep only last 200 IDs to avoid unbounded growth
  const arr = [...alertedEventIds].slice(-200);
  localStorage.setItem('vg_alerted', JSON.stringify(arr));
}

function playAlertSound(isRed) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (isRed) {
      // Three urgent beeps for red alert
      [0, 0.35, 0.7].forEach(offset => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type      = 'square';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.4, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.28);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.28);
      });
    } else {
      // Single double-beep for green alert
      [0, 0.2].forEach(offset => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type      = 'sine';
        osc.frequency.value = 600;
        gain.gain.setValueAtTime(0.3, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.15);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.15);
      });
    }
  } catch(e) { console.warn('Audio not available:', e); }
}

function showAlertPopup(patientName, alertType, message) {
  document.getElementById('alert-popup')?.remove();

  const isRed    = alertType === 'red';
  const isOrange = alertType === 'orange';
  const popup = document.createElement('div');
  popup.id = 'alert-popup';
  popup.innerHTML = `
    <div class="alert-popup-overlay" id="alert-popup-overlay">
      <div class="alert-popup-box ${isRed ? 'popup-red' : 'popup-orange'}">
        <div class="alert-popup-icon">${isRed ? '🚨' : '🟠'}</div>
        <div class="alert-popup-title">${isRed ? 'ALERTA VERMELHO' : 'ALERTA LARANJA'}</div>
        <div class="alert-popup-patient">${patientName}</div>
        <div class="alert-popup-msg">${message}</div>
        <div class="alert-popup-time">${new Date().toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}</div>
        <button class="alert-popup-btn" id="alert-popup-close">
          ${isRed ? 'Reconhecer alerta' : 'OK'}
        </button>
      </div>
    </div>`;
  document.body.appendChild(popup);

  document.getElementById('alert-popup-close').addEventListener('click', () => popup.remove());
  document.getElementById('alert-popup-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) popup.remove();
  });

  if (!isRed) setTimeout(() => popup.remove(), 8000);
}

async function checkForNewAlerts() {
  const notifPref = localStorage.getItem('vg_notif') || 'all';
  if (notifPref === 'none') return;

  for (const p of patients) {
    const ev = latestEvents[p.id];
    if (!ev || alertedEventIds.has(ev.id)) continue;

    const isRed    = ev.alert_state === 'RED_ALERT';
    const isOrange = ev.alert_state === 'ORANGE_ALERT';

    if (!isRed && !isOrange) continue;
    if (notifPref === 'red' && !isRed) continue;

    // Mark as alerted immediately to avoid double-firing
    alertedEventIds.add(ev.id);
    saveAlertedIds();

    const message = isRed
      ? 'Sem resposta após queda — assistência necessária!'
      : 'Movimento súbito detectado.';

    // Save to alerts table
    await createAlert(p.id, isRed ? 'red' : 'green', message).catch(() => {});
    await loadAll();

    // Play sound
    playAlertSound(isRed);

    // Show popup
    showAlertPopup(p.name, isRed ? 'red' : 'orange', message);

    // Browser notification (if permission granted)
    if (Notification.permission === 'granted') {
      new Notification(`VitalGuard — ${isRed ? '🚨 Alerta Vermelho' : '🟠 Alerta Laranja'}`, {
        body: `${p.name}: ${message}`,
        icon: '/favicon.ico',
      });
    }
  }
}

// Request browser notification permission on first load
async function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ─── Realtime table ───────────────────────────────────────────
async function renderRealtimeTable() {
  const tbody = document.getElementById('rt-tbody');
  if (!tbody) return;

  if (!patients.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Sem utentes registados.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  patients.forEach(p => {
    const ev     = latestEvents[p.id] || null;
    const s      = getStatus(ev);
    const colors = avatarColors(p.id);
    const time   = ev ? new Date(ev.created_at).toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' }) : '—';
    const visible = matchesFilter(p, ev);

    const tr = document.createElement('tr');
    tr.dataset.pid    = p.id;
    tr.dataset.status = s;
    tr.dataset.name   = p.name.toLowerCase();
    tr.style.display  = visible ? '' : 'none';
    tr.innerHTML = `
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="avatar" style="width:30px;height:30px;font-size:10px;background:${colors.bg};color:${colors.fg}">${getInitials(p.name)}</div>
          <div style="font-weight:500">${p.name}</div>
        </div>
      </td>
      <td data-label="Estado">
        <span class="alert-state-badge state-${(ev?.alert_state || 'IDLE').toLowerCase()}">
          ${stateLabel(ev?.alert_state || 'IDLE')}
        </span>
      </td>
      <td data-label="Aceleração">${ev?.accel_mag != null ? ev.accel_mag.toFixed(2) + ' g' : '—'}</td>
      <td data-label="Última actualização">${time}</td>
      <td data-label="Ações">
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="action-btn" onclick="showPerfil('${p.id}')">Ver perfil</button>
          <button class="action-btn danger" onclick="handleDeletePatient('${p.id}', '${p.name.replace(/'/g, "\\'")}')">Apagar</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

function applyFilter() {
  document.querySelectorAll('#rt-tbody tr[data-pid]').forEach(row => {
    const p  = patients.find(p => p.id === row.dataset.pid);
    const ev = latestEvents[row.dataset.pid] || null;
    row.style.display = matchesFilter(p, ev) ? '' : 'none';
  });
}

function matchesFilter(p, ev) {
  const s = getStatus(ev);
  const matchStatus = activeFilter === 'todos'
    || (activeFilter === 'ok'   && s === 'ok')
    || (activeFilter === 'warn' && s === 'warn')
    || (activeFilter === 'crit' && s === 'crit');
  const matchSearch = !searchQuery || p.name.toLowerCase().includes(searchQuery);
  return matchStatus && matchSearch;
}

function setFilter(el) {
  document.querySelectorAll('[data-filter]').forEach(c => c.classList.remove('on'));
  el.classList.add('on');
  activeFilter = el.dataset.filter;
  applyFilter();
}

// ─── Delete patient ───────────────────────────────────────────
window.handleDeletePatient = async (id, name) => {
  if (!confirm(`Apagar "${name}"? Remove todos os dados e não pode ser desfeito.`)) return;
  try {
    await deletePatient(id);
    patients = patients.filter(p => p.id !== id);
    renderRealtimeTable();
    renderHome();
    showToast(`"${name}" apagado.`, 'success');
  } catch(e) { showToast('Erro ao apagar.', 'error'); }
};

// ─── Perfil ───────────────────────────────────────────────────
window.showPerfil = async (patientId) => {
  const p = patients.find(p => p.id === patientId);
  if (!p) return;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };

  set('perfil-nome', p.name);
  set('p-inst',    p.institution_id);
  set('p-nhc',     p.nhc);
  set('p-nif',     p.nif);
  set('p-address', p.address);
  set('p-phone',   p.phone);
  set('p-email',   p.email);
  set('p-history', p.health_history);
  set('p-notes',   p.notes);

  if (p.dob) {
    const d = new Date(p.dob);
    set('p-dob', d.toLocaleDateString('pt-PT'));
    set('p-age', Math.floor((Date.now() - d) / 31557600000) + ' anos');
  } else { set('p-dob', '—'); set('p-age', '—'); }

  set('p-height', p.height_cm ? p.height_cm + ' cm' : null);
  set('p-weight', p.weight_kg ? p.weight_kg + ' kg' : null);
  if (p.height_cm && p.weight_kg) {
    set('p-bmi', (p.weight_kg / ((p.height_cm/100)**2)).toFixed(1) + ' kg/m²');
  } else set('p-bmi', '—');

  // Latest event
  const ev = latestEvents[patientId] || null;
  const s  = getStatus(ev);
  const badge = document.getElementById('perfil-badge');
  if (badge) {
    badge.textContent = s === 'ok' ? 'Normal' : s === 'warn' ? 'Atenção' : 'Alerta';
    badge.className   = `badge badge-${s === 'ok' ? 'ok' : s === 'warn' ? 'warn' : 'alert'}`;
  }

  if (ev) {
    set('p-state',    stateLabel(ev.alert_state));
    set('p-accel',    ev.accel_mag  != null ? ev.accel_mag.toFixed(2)  + ' g'   : null);
    set('p-gyro',     ev.gyro_mag   != null ? ev.gyro_mag.toFixed(1)   + ' °/s' : null);
    set('p-mic',      ev.mic_active ? 'Sim' : 'Não');
    set('p-fall',     ev.fall_detected ? '⚠ Sim' : 'Não');
    set('p-readtime', new Date(ev.created_at).toLocaleString('pt-PT'));
  } else {
    ['p-state','p-accel','p-gyro','p-mic','p-fall','p-readtime'].forEach(id => set(id, '—'));
  }

  document.getElementById('perfil-back')?.addEventListener('click', () => goTo('registos'), { once: true });
  goTo('perfil');
};

// ─── Registos ─────────────────────────────────────────────────
async function renderRegistos() {
  const tbody = document.getElementById('reg-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="loading"><div class="spinner"></div>A carregar...</div></td></tr>';

  try {
    const events = await getAllEvents(300);
    tbody.innerHTML = '';

    if (!events.length && !patients.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Sem dados.</td></tr>';
      return;
    }

    // Patients with no events
    const pidsWithEvents = new Set(events.map(e => e.patient_id));
    patients.filter(p => !pidsWithEvents.has(p.id)).forEach(p => {
      const colors = avatarColors(p.id);
      tbody.innerHTML += `<tr>
        <td>—</td><td>—</td>
        <td><div style="display:flex;align-items:center;gap:8px">
          <div class="avatar" style="width:24px;height:24px;font-size:9px;background:${colors.bg};color:${colors.fg}">${getInitials(p.name)}</div>
          <span style="font-weight:500">${p.name}</span>
        </div></td>
        <td><span class="alert-state-badge state-idle">Sem dados</span></td>
        <td>—</td>
        <td><button class="action-btn" onclick="showPerfil('${p.id}')">Ver perfil</button></td>
      </tr>`;
    });

    events.forEach(ev => {
      const pName  = ev.patients?.name || 'Desconhecido';
      const pid    = ev.patient_id;
      const p      = patients.find(p => p.id === pid);
      const colors = avatarColors(pid);
      const date   = new Date(ev.created_at);
      tbody.innerHTML += `<tr>
        <td data-label="Data">${date.toLocaleDateString('pt-PT', { day:'2-digit', month:'short' })}</td>
        <td data-label="Hora" style="font-family:var(--font-mono)">${date.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' })}</td>
        <td><div style="display:flex;align-items:center;gap:8px">
          <div class="avatar" style="width:24px;height:24px;font-size:9px;background:${colors.bg};color:${colors.fg}">${getInitials(pName)}</div>
          <span style="font-weight:500">${pName}</span>
        </div></td>
        <td data-label="Estado"><span class="alert-state-badge state-${ev.alert_state.toLowerCase()}">${stateLabel(ev.alert_state)}</span></td>
        <td data-label="Aceleração">${ev.accel_mag != null ? ev.accel_mag.toFixed(2) + ' g' : '—'}</td>
        <td>${p ? `<button class="action-btn" onclick="showPerfil('${pid}')">Ver perfil</button>` : ''}</td>
      </tr>`;
    });
  } catch(e) {
    console.error(e);
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Erro ao carregar.</td></tr>';
  }
}

// ─── Add patient ──────────────────────────────────────────────
async function handleAddPatient(e) {
  e.preventDefault();
  const btn = document.getElementById('submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'A adicionar...'; }

  const g = id => document.getElementById(id)?.value?.trim() || '';
  const patient = {
    name:           g('f-nome'),
    institution_id: g('f-inst'),
    nhc:            g('f-utente'),
    nif:            g('f-nif'),
    dob:            document.getElementById('f-dob')?.value || null,
    address:        [g('f-morada'), g('f-loc'), g('f-cp')].filter(Boolean).join(', '),
    phone:          g('f-tel'),
    email:          g('f-email'),
    height_cm:      document.getElementById('f-altura')?.value ? parseFloat(document.getElementById('f-altura').value) : null,
    weight_kg:      document.getElementById('f-peso')?.value  ? parseFloat(document.getElementById('f-peso').value)   : null,
    health_history: g('f-historico'),
    notes:          g('f-notas'),
  };

  try {
    await addPatient(patient);
    patients = await getPatients();
    clearForm();
    showToast(`"${patient.name}" adicionado!`, 'success');
    setTimeout(() => goTo('home'), 900);
  } catch(e) {
    showToast('Erro: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Adicionar utente'; }
  }
}
function clearForm() { document.getElementById('add-form')?.reset(); }

// ─── Export CSV ───────────────────────────────────────────────
async function exportCSV() {
  try {
    const events = await getAllEvents(2000);
    const rows = [['Data','Hora','Utente','Estado','Aceleração (g)','Giroscópio (°/s)','Microfone','Queda']];
    events.forEach(ev => {
      const d = new Date(ev.created_at);
      rows.push([
        d.toLocaleDateString('pt-PT'),
        d.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' }),
        ev.patients?.name || '',
        ev.alert_state,
        ev.accel_mag?.toFixed(2) ?? '',
        ev.gyro_mag?.toFixed(1)  ?? '',
        ev.mic_active ? 'Sim' : 'Não',
        ev.fall_detected ? 'Sim' : 'Não',
      ]);
    });
    const csv  = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href=url; a.download='vitalguard_eventos.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exportado!', 'success');
  } catch(e) { showToast('Erro ao exportar.', 'error'); }
}

// ─── Edit / delete notes ──────────────────────────────────────
window.editNotes = (patientId, btn) => {
  const cell = btn.closest('.notes-cell');
  const current = cell.dataset.notes || '';
  cell.innerHTML = `
    <div style="display:flex;gap:6px;flex-direction:column;width:100%">
      <textarea class="field-input" style="height:60px;padding:6px 8px;font-size:12px;resize:vertical">${current}</textarea>
      <div style="display:flex;gap:6px">
        <button class="action-btn" onclick="saveNotes('${patientId}', this)">✓ Guardar</button>
        <button class="action-btn" onclick="goTo('registos')">✕ Cancelar</button>
      </div>
    </div>`;
  cell.querySelector('textarea').focus();
};
window.saveNotes = async (patientId, btn) => {
  const newNotes = btn.closest('.notes-cell').querySelector('textarea').value.trim();
  try {
    await updatePatient(patientId, { notes: newNotes });
    const p = patients.find(p => p.id === patientId);
    if (p) p.notes = newNotes;
    showToast('Guardado!', 'success');
    renderRegistos();
  } catch(e) { showToast('Erro.', 'error'); }
};

// ─── Settings ─────────────────────────────────────────────────
function initSettings() {
  document.getElementById('settings-save')?.addEventListener('click', () => {
    showToast('Definições guardadas!', 'success');
  });
  document.getElementById('settings-reset')?.addEventListener('click', () => {
    showToast('Definições repostas.');
  });
}

// ─── Helpers ──────────────────────────────────────────────────
function getStatus(ev) {
  if (!ev) return 'ok';
  switch (ev.alert_state) {
    case 'RED_ALERT':                                          return 'crit';
    case 'ORANGE_ALERT': case 'WAITING_SOUND':                return 'warn';
    case 'WAITING_STILLNESS':                                 return 'warn';
    default:                                                  return 'ok';
  }
}

function stateLabel(state) {
  switch (state) {
    case 'IDLE':              return 'Normal';
    case 'ORANGE_ALERT':      return 'Alerta laranja';
    case 'WAITING_STILLNESS': return 'A observar';
    case 'WAITING_SOUND':     return 'À espera de resposta';
    case 'RED_ALERT':         return 'Alerta vermelho';
    default:                  return state || 'Sem dados';
  }
}

function getInitials(name) {
  return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
}

const PALETTE = [
  {bg:'#B5D4F4',fg:'#0C447C'},{bg:'#F5C4B3',fg:'#712B13'},
  {bg:'#C0DD97',fg:'#27500A'},{bg:'#D3D1C7',fg:'#444441'},
  {bg:'#F7C1C1',fg:'#791F1F'},{bg:'#FAC775',fg:'#854F0B'},
];
function avatarColors(id) {
  return PALETTE[(id?.charCodeAt(0) || 0) % PALETTE.length];
}

export function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = type ? `show ${type}` : 'show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className = '', 3000);
}

window.goTo = goTo;
