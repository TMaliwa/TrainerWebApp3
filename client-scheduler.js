// ---- Auth guard ----
  const AUTH_KEY = 'sessionbook-auth';
  function getAuth() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  const auth = getAuth();
  if (!auth || !auth.token) {
    window.location.href = 'login.html';
  }

  // ---- State ----
  // Data lives in a Google Sheet via a small Apps Script API. The URL is
  // hardcoded here rather than exposed in a settings screen — see
  // BACKEND_URL below. Update it here (and in login.js) if you ever
  // redeploy the Apps Script and get a new URL.
  // localStorage is used as an offline cache and fallback if a sync
  // request fails. Cache keys are namespaced by the signed-in trainer's
  // email so two trainers sharing one device/browser never see or
  // overwrite each other's cached data.
  const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzRZ3pYTYQmQnBa2fchcQtIKJ1E-42xFq2WomTBDGYAQhuzDZyI9oADBaQSWB6CMFYS/exec';
  const ownerKey = (auth && auth.email) ? auth.email.toLowerCase() : 'anonymous';
  const STORAGE_KEY = 'sessionbook-clients-' + ownerKey;
  const APPTS_STORAGE_KEY = 'sessionbook-appointments-' + ownerKey;

  const DEFAULT_CLIENTS = [];

  function getBackendUrl() {
    return BACKEND_URL;
  }

  function loadClientsLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error('Could not load cached clients:', e);
    }
    return DEFAULT_CLIENTS;
  }

  function loadAppointmentsLocal() {
    try {
      const raw = localStorage.getItem(APPTS_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error('Could not load cached appointments:', e);
    }
    return [];
  }

  function cacheClientsLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clients));
      localStorage.setItem(APPTS_STORAGE_KEY, JSON.stringify(appointments));
    } catch (e) {
      console.error('Could not cache data:', e);
    }
  }

  let clients = loadClientsLocal();
  let appointments = loadAppointmentsLocal();
  let query = "";
  let openResetId = null;
  let openScheduleId = null;
  let openEditId = null;
  let openHistoryClientId = null;
  let view = "clients"; // "clients" | "schedule" | "history"
  let syncing = false;
  let syncError = false;

  // Save = cache locally immediately, then push to the backend if configured.
  function saveClients() {
    cacheClientsLocal();
    const url = getBackendUrl();
    if (!url || !auth) return;
    syncing = true;
    syncError = false;
    updateSyncBadge();

    const clientsReq = fetch(url + '?action=syncClients&token=' + encodeURIComponent(auth.token)
      + '&clients=' + encodeURIComponent(JSON.stringify(clients)))
      .then(res => res.json());

    const apptsReq = fetch(url + '?action=syncAppointments&token=' + encodeURIComponent(auth.token)
      + '&appointments=' + encodeURIComponent(JSON.stringify(appointments)))
      .then(res => res.json());

    Promise.all([clientsReq, apptsReq])
      .then(([clientsData, apptsData]) => {
        syncing = false;
        if ((clientsData && clientsData.error === 'unauthorized') || (apptsData && apptsData.error === 'unauthorized')) {
          signOut();
          return;
        }
        syncError = !(clientsData && clientsData.success === true && apptsData && apptsData.success === true);
        updateSyncBadge();
      })
      .catch(err => {
        console.error('Sync failed:', err);
        syncing = false;
        syncError = true;
        updateSyncBadge();
      });
  }

  // On load, pull the latest from the backend (if configured) so all your
  // devices agree on the current list.
  function fetchClientsFromBackend() {
    const url = getBackendUrl();
    if (!url || !auth) return;
    syncing = true;
    syncError = false;
    updateSyncBadge();
    fetch(url + '?token=' + encodeURIComponent(auth.token))
      .then(res => res.json())
      .then(data => {
        if (data && data.error === 'unauthorized') {
          syncing = false;
          signOut();
          return;
        }
        if (Array.isArray(data)) {
          // Backward compatibility with the old bare-array response shape.
          clients = data;
        } else if (data && Array.isArray(data.clients)) {
          clients = data.clients;
          appointments = Array.isArray(data.appointments) ? data.appointments : [];
        }
        cacheClientsLocal();
        render();
        syncing = false;
        updateSyncBadge();
      })
      .catch(err => {
        console.error('Initial fetch failed, using cached data:', err);
        syncing = false;
        syncError = true;
        updateSyncBadge();
      });
  }

  function updateSyncBadge() {
    const badge = document.getElementById('syncBadge');
    if (!badge) return;
    const url = getBackendUrl();
    if (!url) {
      badge.textContent = 'Not connected · saving on this device only';
      badge.style.color = '#8b93a1';
    } else if (syncing) {
      badge.textContent = 'Syncing…';
      badge.style.color = '#8b93a1';
    } else if (syncError) {
      badge.textContent = 'Sync failed · check backend URL';
      badge.style.color = '#D6402D';
    } else {
      badge.textContent = 'Synced to Google Sheet';
      badge.style.color = '#7ac298';
    }
  }

  const grid = document.getElementById('grid');
  const emptyState = document.getElementById('emptyState');
  const scheduleView = document.getElementById('scheduleView');
  const clientsToolbar = document.getElementById('clientsToolbar');
  const statClients = document.getElementById('statClients');
  const statSessions = document.getElementById('statSessions');
  const overlay = document.getElementById('overlay');
  const addForm = document.getElementById('addForm');

  const historyView = document.getElementById('historyView');
  const tabButtons = {
    clients: document.getElementById('tabClients'),
    schedule: document.getElementById('tabSchedule'),
    history: document.getElementById('tabHistory'),
  };
  function setView(newView) {
    view = newView;
    Object.keys(tabButtons).forEach(key => {
      tabButtons[key].classList.toggle('active', key === newView);
    });
    render();
  }
  tabButtons.clients.addEventListener('click', () => setView('clients'));
  tabButtons.schedule.addEventListener('click', () => setView('schedule'));
  tabButtons.history.addEventListener('click', () => setView('history'));

  function initials(name) {
    return name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${dateStr} · ${timeStr}`;
  }

  function nextAppointmentFor(clientId) {
    const now = Date.now();
    const upcoming = appointments
      .filter(a => a.clientId === clientId && !a.completed && new Date(a.datetime).getTime() >= now)
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    return upcoming[0] || null;
  }

  function render() {
    statClients.textContent = clients.length;
    statSessions.textContent = appointments.filter(a => !a.completed).length;

    if (view === 'schedule') {
      clientsToolbar.style.display = 'none';
      grid.style.display = 'none';
      emptyState.style.display = 'none';
      scheduleView.style.display = 'block';
      historyView.style.display = 'none';
      renderScheduleView();
      return;
    }

    if (view === 'history') {
      clientsToolbar.style.display = 'none';
      grid.style.display = 'none';
      emptyState.style.display = 'none';
      scheduleView.style.display = 'none';
      historyView.style.display = 'block';
      renderHistoryView();
      return;
    }

    clientsToolbar.style.display = 'flex';
    scheduleView.style.display = 'none';
    historyView.style.display = 'none';

    const filtered = clients.filter(c =>
      c.name.toLowerCase().includes(query.toLowerCase())
    );

    if (filtered.length === 0) {
      grid.style.display = 'none';
      emptyState.style.display = 'block';
      emptyState.textContent = clients.length === 0
        ? "No clients yet. Add your first client to start tracking sessions."
        : "No clients match that search.";
      return;
    }
    grid.style.display = 'grid';
    emptyState.style.display = 'none';

    grid.innerHTML = filtered.map(c => cardHtml(c)).join('');
    attachCardListeners();
  }

  function renderScheduleView() {
    const now = Date.now();
    const upcoming = appointments
      .filter(a => !a.completed)
      .slice()
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    if (upcoming.length === 0) {
      scheduleView.innerHTML = `<div class="empty-state">No sessions scheduled yet. Open a client card and hit "Schedule" to add one.</div>`;
      return;
    }

    const groups = {};
    const order = [];
    upcoming.forEach(a => {
      const d = new Date(a.datetime);
      const dayKey = isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      if (!groups[dayKey]) { groups[dayKey] = []; order.push(dayKey); }
      groups[dayKey].push(a);
    });

    scheduleView.innerHTML = order.map(dayKey => {
      const rows = groups[dayKey].map(a => {
        const c = clients.find(cl => cl.id === a.clientId);
        const overdue = new Date(a.datetime).getTime() < now;
        const timeStr = new Date(a.datetime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return `
          <div class="appt-row${overdue ? ' appt-overdue' : ''}" data-appt-id="${a.id}">
            <div class="appt-time">${timeStr}</div>
            <div class="appt-info">
              <div class="appt-client">${c ? escapeHtml(c.name) : 'Unknown client'}</div>
              ${a.notes ? `<div class="appt-notes">${escapeHtml(a.notes)}</div>` : ''}
            </div>
            <div class="appt-actions">
              <button class="btn btn-add" data-action="complete-appt" data-id="${a.id}" title="Mark this session complete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Done
              </button>
              <button class="btn btn-schedule" data-action="postpone-appt" data-id="${a.id}" title="Postpone — refunds the session so you can reschedule later">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Postpone
              </button>
              <button class="icon-btn remove-btn" data-action="cancel-appt" data-id="${a.id}" aria-label="Cancel session" title="Cancel session (does not refund the session)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        `;
      }).join('');
      return `<div class="schedule-day"><div class="schedule-day-label">${dayKey}</div>${rows}</div>`;
    }).join('');

    scheduleView.querySelectorAll('[data-action="complete-appt"]').forEach(btn => {
      btn.addEventListener('click', () => {
        // The session was already deducted when this was scheduled, so
        // completing it just marks it done — no further balance change.
        const appt = appointments.find(a => a.id === btn.dataset.id);
        if (appt) appt.completed = true;
        saveClients();
        render();
      });
    });
    scheduleView.querySelectorAll('[data-action="postpone-appt"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const appt = appointments.find(a => a.id === btn.dataset.id);
        if (appt) {
          const c = clients.find(cl => cl.id === appt.clientId);
          // Postponing refunds the session that was reserved when this
          // was scheduled, so the client isn't charged for a session
          // that hasn't happened yet — reschedule later to deduct again.
          if (c) c.sessions = Math.min(c.cap, c.sessions + 1);
          appointments = appointments.filter(a => a.id !== appt.id);
        }
        saveClients();
        render();
      });
    });
    scheduleView.querySelectorAll('[data-action="cancel-appt"]').forEach(btn => {
      btn.addEventListener('click', () => {
        appointments = appointments.filter(a => a.id !== btn.dataset.id);
        saveClients();
        render();
      });
    });
  }

  function renderHistoryView() {
    const completed = appointments.filter(a => a.completed);

    if (completed.length === 0) {
      historyView.innerHTML = `<div class="empty-state">No completed sessions yet. Mark a scheduled session "Done" to see it show up here.</div>`;
      return;
    }

    // Group completed sessions by client, most-recent-first within each.
    const byClient = {};
    completed.forEach(a => {
      if (!byClient[a.clientId]) byClient[a.clientId] = [];
      byClient[a.clientId].push(a);
    });

    const summaryOrder = Object.keys(byClient)
      .map(clientId => {
        const c = clients.find(cl => cl.id === clientId);
        const sessions = byClient[clientId].slice().sort((x, y) => new Date(y.datetime) - new Date(x.datetime));
        return { clientId, name: c ? c.name : 'Unknown client', sessions };
      })
      .sort((a, b) => b.sessions.length - a.sessions.length);

    const summaryHtml = `
      <div class="appt-row" style="margin-bottom:18px;">
        <div class="appt-info">
          <div class="appt-client">Total completed sessions</div>
        </div>
        <div class="count-num" style="font-size:22px;">${completed.length}</div>
      </div>
    `;

    const rowsHtml = summaryOrder.map(entry => {
      const open = openHistoryClientId === entry.clientId;
      const sessionListHtml = open ? `
        <div style="padding: 4px 14px 12px;">
          ${entry.sessions.map(a => `
            <div class="appt-notes" style="margin-top:6px; color:#EDEBE4;">
              ${formatDateTime(a.datetime)}${a.notes ? ` — ${escapeHtml(a.notes)}` : ''}
            </div>
          `).join('')}
        </div>
      ` : '';
      return `
        <div class="schedule-day">
          <div class="appt-row" data-action="toggle-history" data-id="${entry.clientId}" style="cursor:pointer;">
            <div class="appt-info">
              <div class="appt-client">${escapeHtml(entry.name)}</div>
              <div class="appt-notes">${entry.sessions.length} completed session${entry.sessions.length === 1 ? '' : 's'}</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${open ? '180' : '0'}deg); transition: transform 0.15s ease;"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          ${sessionListHtml}
        </div>
      `;
    }).join('');

    historyView.innerHTML = summaryHtml + rowsHtml;

    historyView.querySelectorAll('[data-action="toggle-history"]').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        openHistoryClientId = openHistoryClientId === id ? null : id;
        render();
      });
    });
  }

  function cardHtml(c) {
    const empty = c.sessions === 0;
    const total = Math.max(c.cap, c.sessions, 1);
    let dots = '';
    for (let i = 0; i < total; i++) {
      dots += `<span class="dot${i < c.sessions ? ' dot-filled' : ''}"></span>`;
    }
    const showReset = openResetId === c.id;
    const showSchedule = openScheduleId === c.id;
    const showEdit = openEditId === c.id;
    const next = nextAppointmentFor(c.id);

    return `
      <div class="card${empty ? ' card-empty' : ''}" data-id="${c.id}">
        <div class="card-top">
          <div class="avatar">${initials(c.name)}</div>
          <div class="card-name-wrap">
            <div class="card-name">${escapeHtml(c.name)}</div>
            <div class="card-sub">${empty ? 'No sessions left' : `${c.sessions} of ${c.cap} left`}</div>
          </div>
          <button class="icon-btn edit-btn" data-action="toggle-edit" data-id="${c.id}" aria-label="Edit ${escapeHtml(c.name)}" title="Edit client">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn remove-btn" data-action="remove" data-id="${c.id}" aria-label="Remove ${escapeHtml(c.name)}" title="Remove client">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>

        <div class="count-row">
          <span class="count-num">${c.sessions}</span>
          <span class="count-label">sessions</span>
        </div>

        <div class="dotrow" aria-hidden="true">${dots}</div>

        ${next ? `
        <div class="next-session">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          Next: ${formatDateTime(next.datetime)}
        </div>` : ''}

        ${c.phone ? `
        <div class="next-session" style="color:#8b93a1;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          ${escapeHtml(c.phone)}
        </div>` : ''}

        ${!c.email ? `
        <div class="next-session" style="color:#8b93a1;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          No email on file — booking confirmations won't send
        </div>` : ''}

        <div class="btn-row">
          <button class="btn btn-deduct" data-action="deduct" data-id="${c.id}" ${c.sessions === 0 ? 'disabled' : ''}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Use one
          </button>
          <button class="btn btn-add" data-action="add" data-id="${c.id}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add one
          </button>
          <button class="btn btn-schedule" data-action="toggle-schedule" data-id="${c.id}" ${c.sessions === 0 ? 'disabled title="No sessions remaining"' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            Schedule
          </button>
          <button class="btn btn-reset" data-action="toggle-reset" data-id="${c.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            Reset
          </button>
        </div>

        ${showEdit ? `
        <form class="reset-form" data-action="edit-form" data-id="${c.id}">
          <label>Edit client details</label>
          <div class="reset-inputs" style="flex-wrap: wrap;">
            <input type="text" id="edit-name-${c.id}" value="${escapeHtml(c.name)}" placeholder="Full name" required style="width:auto; flex:1;" />
          </div>
          <div class="reset-inputs">
            <input type="email" id="edit-email-${c.id}" value="${escapeHtml(c.email || '')}" placeholder="client@example.com" style="width:auto; flex:1;" />
          </div>
          <div class="reset-inputs">
            <input type="tel" id="edit-phone-${c.id}" value="${escapeHtml(c.phone || '')}" placeholder="082 123 4567" style="width:auto; flex:1;" />
          </div>
          <div class="reset-inputs">
            <button type="submit" class="btn btn-confirm">Save</button>
            <button type="button" class="btn btn-cancel" data-action="cancel-edit">Cancel</button>
          </div>
        </form>` : ''}

        ${showReset ? `
        <form class="reset-form" data-action="reset-form" data-id="${c.id}">
          <label for="reset-${c.id}">Set remaining sessions to</label>
          <div class="reset-inputs">
            <input type="number" min="0" id="reset-${c.id}" value="${c.sessions}" autofocus />
            <button type="submit" class="btn btn-confirm">Set</button>
            <button type="button" class="btn btn-cancel" data-action="cancel-reset">Cancel</button>
          </div>
        </form>` : ''}

        ${showSchedule ? `
        <form class="reset-form" data-action="schedule-form" data-id="${c.id}">
          <label>Schedule a session</label>
          <div class="reset-inputs" style="flex-wrap: wrap;">
            <input type="date" id="sched-date-${c.id}" required style="width:auto; flex:1;" />
            <input type="time" id="sched-time-${c.id}" required style="width:auto; flex:1;" />
          </div>
          <div class="reset-inputs">
            <input type="text" id="sched-notes-${c.id}" placeholder="Notes (optional)" style="width:auto; flex:1;" />
          </div>
          <div class="reset-inputs">
            <button type="submit" class="btn btn-confirm">Schedule</button>
            <button type="button" class="btn btn-cancel" data-action="cancel-schedule">Cancel</button>
          </div>
        </form>` : ''}
      </div>
    `;
  }

  function attachCardListeners() {
    grid.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const pending = appointments.filter(a => a.clientId === id && !a.completed);
        if (pending.length > 0) {
          const c = clients.find(c => c.id === id);
          const name = c ? c.name : 'This client';
          alert(`${name} has ${pending.length} pending session${pending.length === 1 ? '' : 's'} scheduled. Cancel or complete ${pending.length === 1 ? 'it' : 'them'} from the Schedule tab before removing this client.`);
          return;
        }
        clients = clients.filter(c => c.id !== id);
        saveClients();
        render();
      });
    });
    grid.querySelectorAll('[data-action="deduct"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = clients.find(c => c.id === btn.dataset.id);
        if (c) c.sessions = Math.max(0, c.sessions - 1);
        saveClients();
        render();
      });
    });
    grid.querySelectorAll('[data-action="add"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = clients.find(c => c.id === btn.dataset.id);
        if (c) { c.sessions += 1; c.cap = Math.max(c.cap, c.sessions); }
        saveClients();
        render();
      });
    });
    grid.querySelectorAll('[data-action="toggle-reset"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openResetId = openResetId === btn.dataset.id ? null : btn.dataset.id;
        render();
      });
    });
    grid.querySelectorAll('[data-action="cancel-reset"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openResetId = null;
        render();
      });
    });
    grid.querySelectorAll('[data-action="reset-form"]').forEach(form => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const input = form.querySelector('input');
        const n = parseInt(input.value, 10);
        if (!Number.isNaN(n) && n >= 0) {
          const c = clients.find(c => c.id === id);
          if (c) { c.sessions = n; c.cap = Math.max(c.cap, n); }
          openResetId = null;
          saveClients();
          render();
        }
      });
    });
    grid.querySelectorAll('[data-action="toggle-edit"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openEditId = openEditId === btn.dataset.id ? null : btn.dataset.id;
        render();
      });
    });
    grid.querySelectorAll('[data-action="cancel-edit"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openEditId = null;
        render();
      });
    });
    grid.querySelectorAll('[data-action="edit-form"]').forEach(form => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const name = document.getElementById(`edit-name-${id}`).value.trim();
        const email = document.getElementById(`edit-email-${id}`).value.trim();
        const phone = document.getElementById(`edit-phone-${id}`).value.trim();
        if (!name) return;
        const c = clients.find(c => c.id === id);
        if (c) { c.name = name; c.email = email; c.phone = phone; }
        openEditId = null;
        saveClients();
        render();
      });
    });
    grid.querySelectorAll('[data-action="toggle-schedule"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openScheduleId = openScheduleId === btn.dataset.id ? null : btn.dataset.id;
        render();
      });
    });
    grid.querySelectorAll('[data-action="cancel-schedule"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openScheduleId = null;
        render();
      });
    });
    grid.querySelectorAll('[data-action="schedule-form"]').forEach(form => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const dateVal = document.getElementById(`sched-date-${id}`).value;
        const timeVal = document.getElementById(`sched-time-${id}`).value;
        const notesVal = document.getElementById(`sched-notes-${id}`).value.trim();
        if (!dateVal || !timeVal) return;

        const c = clients.find(cl => cl.id === id);
        if (c && c.sessions <= 0) {
          alert(`${c.name} has no sessions remaining. Add sessions before scheduling one.`);
          return;
        }

        const datetime = new Date(`${dateVal}T${timeVal}`).toISOString();

        const conflict = findConflict(datetime, id);
        if (conflict) {
          const conflictClient = clients.find(cl => cl.id === conflict.clientId);
          const proceed = confirm(
            `${conflictClient ? conflictClient.name : 'Another client'} already has a session around ${formatDateTime(conflict.datetime)}. Schedule this one anyway?`
          );
          if (!proceed) return;
        }

        appointments.push({
          id: 'a' + Date.now(),
          clientId: id,
          datetime,
          notes: notesVal,
          completed: false,
        });
        // Scheduling reserves a session against the client's remaining balance.
        if (c) c.sessions = Math.max(0, c.sessions - 1);
        openScheduleId = null;
        saveClients();
        render();

        if (c && c.email) {
          sendBookingConfirmation(c, datetime, notesVal);
        }
      });
    });
  }

  // Two bookings are treated as conflicting if they fall within one
  // session length of each other for two different clients.
  const SESSION_DURATION_MINUTES = 60;
  function findConflict(datetimeIso, excludeClientId) {
    const target = new Date(datetimeIso).getTime();
    return appointments.find(a => {
      if (a.completed) return false;
      if (a.clientId === excludeClientId) return false;
      const t = new Date(a.datetime).getTime();
      return Math.abs(t - target) < SESSION_DURATION_MINUTES * 60000;
    }) || null;
  }

  // Fire-and-forget: let the trainer know if it fails, but don't block
  // the scheduling flow on it.
  function sendBookingConfirmation(client, datetimeIso, notes) {
    const url = getBackendUrl();
    if (!url || !auth) return;
    const q = '?action=notifyBooking&token=' + encodeURIComponent(auth.token)
      + '&email=' + encodeURIComponent(client.email)
      + '&clientName=' + encodeURIComponent(client.name)
      + '&datetime=' + encodeURIComponent(datetimeIso)
      + '&notes=' + encodeURIComponent(notes || '');
    fetch(url + q)
      .then(res => res.json())
      .then(data => {
        if (!data || data.success !== true) {
          console.error('Booking confirmation email failed:', data && data.error);
        }
      })
      .catch(err => console.error('Booking confirmation email failed:', err));
  }

  document.getElementById('searchInput').addEventListener('input', (e) => {
    query = e.target.value;
    render();
  });

  document.getElementById('openAddBtn').addEventListener('click', () => {
    overlay.classList.remove('hidden');
    document.getElementById('newName').focus();
  });
  document.getElementById('closeAddBtn').addEventListener('click', () => {
    overlay.classList.add('hidden');
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('newName').value.trim();
    const email = document.getElementById('newEmail').value.trim();
    const phone = document.getElementById('newPhone').value.trim();
    const sessions = parseInt(document.getElementById('newSessions').value, 10);
    if (!name || Number.isNaN(sessions) || sessions < 0) return;
    clients.push({
      id: 'c' + Date.now(),
      name,
      email,
      phone,
      sessions,
      cap: Math.max(sessions, 1),
    });
    addForm.reset();
    document.getElementById('newSessions').value = '10';
    overlay.classList.add('hidden');
    saveClients();
    render();
  });

  function signOut() {
    localStorage.removeItem(AUTH_KEY);
    window.location.href = 'login.html';
  }

  document.getElementById('signOutBtn').addEventListener('click', () => {
    if (confirm('Sign out of Session Book on this device?')) {
      signOut();
    }
  });

  updateSyncBadge();
  fetchClientsFromBackend();
  render();