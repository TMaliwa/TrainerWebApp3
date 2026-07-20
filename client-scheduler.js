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

  // ---- Google Places autocomplete for the session location field ----
  // Paste your Google Maps API key here (see the setup guide) to turn on
  // address suggestions. Leave blank and the Location field still works
  // as a plain text input — it just won't suggest addresses as you type.
  // Calls the Places API (New) Autocomplete REST endpoint directly (no
  // separate Maps JS SDK to load) — requires "Places API (New)" enabled
  // on the Google Cloud project this key belongs to.
  const GOOGLE_MAPS_API_KEY = 'AIzaSyCpFoMSHMFdFClcIW_kkUKz30BEZgDQDVk';

  let locationSuggestDebounce = null;

  // No-op (leaves a plain text input) if no key is configured.
  function bindLocationAutocomplete(inputEl) {
    if (!inputEl || !GOOGLE_MAPS_API_KEY) return;
    let list = inputEl.nextElementSibling;
    if (!list || !list.classList.contains('location-suggestions')) {
      list = document.createElement('div');
      list.className = 'location-suggestions';
      inputEl.insertAdjacentElement('afterend', list);
    }
    inputEl.addEventListener('input', () => {
      clearTimeout(locationSuggestDebounce);
      const query = inputEl.value.trim();
      if (!query) { list.innerHTML = ''; list.style.display = 'none'; return; }
      locationSuggestDebounce = setTimeout(() => fetchLocationSuggestions(query, inputEl, list), 300);
    });
    inputEl.addEventListener('blur', () => {
      // Let a click on a suggestion register before hiding the list.
      setTimeout(() => { list.style.display = 'none'; }, 150);
    });
  }

  function fetchLocationSuggestions(query, inputEl, list) {
    fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY },
      body: JSON.stringify({ input: query }),
    })
      .then(res => res.json())
      .then(data => {
        const suggestions = (data.suggestions || []).slice(0, 5)
          .map(s => s.placePrediction && s.placePrediction.text && s.placePrediction.text.text)
          .filter(Boolean);
        if (!suggestions.length) { list.innerHTML = ''; list.style.display = 'none'; return; }
        list.innerHTML = suggestions.map(text => `<div class="location-suggestion">${escapeHtml(text)}</div>`).join('');
        list.style.display = 'block';
        list.querySelectorAll('.location-suggestion').forEach((el, i) => {
          el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            inputEl.value = suggestions[i];
            list.style.display = 'none';
          });
        });
      })
      .catch(err => console.error('Location suggestions failed:', err));
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
  let openPostponeId = null;
  let openHistoryClientId = null;
  let view = "clients"; // "clients" | "schedule" | "calendar" | "history"
  let syncing = false;
  let syncError = false;

  // ---- Calendar view state ----
  const CAL_START_HOUR = 5; // 5am
  const CAL_END_HOUR = 21; // 9pm
  function startOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // Monday-start week
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }
  let calendarWeekStart = startOfWeek(new Date());
  let calPendingSlot = null; // { date: 'YYYY-MM-DD', time: 'HH:MM' } while picking a client for an open slot

  // ---- History stats chart state ----
  let statsPeriodType = 'week'; // "day" | "week" | "month" | "year"
  let statsAnchorDate = new Date();

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
  const calendarView = document.getElementById('calendarView');
  const tabButtons = {
    clients: document.getElementById('tabClients'),
    schedule: document.getElementById('tabSchedule'),
    calendar: document.getElementById('tabCalendar'),
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
  tabButtons.calendar.addEventListener('click', () => setView('calendar'));
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

  function toLocalDateInputValue(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function toLocalTimeInputValue(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function nextAppointmentFor(clientId) {
    const now = Date.now();
    const upcoming = appointments
      .filter(a => a.clientId === clientId && !a.completed && !a.cancelled && new Date(a.datetime).getTime() >= now)
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    return upcoming[0] || null;
  }

  function render() {
    statClients.textContent = clients.length;
    statSessions.textContent = appointments.filter(a => !a.completed && !a.cancelled).length;

    if (view === 'schedule') {
      clientsToolbar.style.display = 'none';
      grid.style.display = 'none';
      emptyState.style.display = 'none';
      scheduleView.style.display = 'block';
      calendarView.style.display = 'none';
      historyView.style.display = 'none';
      renderScheduleView();
      return;
    }

    if (view === 'calendar') {
      clientsToolbar.style.display = 'none';
      grid.style.display = 'none';
      emptyState.style.display = 'none';
      scheduleView.style.display = 'none';
      calendarView.style.display = 'block';
      historyView.style.display = 'none';
      renderCalendarView();
      return;
    }

    if (view === 'history') {
      clientsToolbar.style.display = 'none';
      grid.style.display = 'none';
      emptyState.style.display = 'none';
      scheduleView.style.display = 'none';
      calendarView.style.display = 'none';
      historyView.style.display = 'block';
      renderHistoryView();
      return;
    }

    clientsToolbar.style.display = 'flex';
    scheduleView.style.display = 'none';
    calendarView.style.display = 'none';
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
      .filter(a => !a.completed && !a.cancelled)
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
        const apptDate = new Date(a.datetime);
        const overdue = apptDate.getTime() < now;
        const timeStr = apptDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const showPostpone = openPostponeId === a.id;
        const postponeDateVal = isNaN(apptDate.getTime()) ? '' : toLocalDateInputValue(apptDate);
        const postponeTimeVal = isNaN(apptDate.getTime()) ? '' : toLocalTimeInputValue(apptDate);
        return `
          <div data-appt-id="${a.id}">
            <div class="appt-row${overdue ? ' appt-overdue' : ''}">
              <div class="appt-time">${timeStr}</div>
              <div class="appt-info">
                <div class="appt-client">${c ? escapeHtml(c.name) : 'Unknown client'}</div>
                ${a.location ? `<div class="appt-notes">Location: ${escapeHtml(a.location)}</div>` : ''}
                ${a.notes ? `<div class="appt-notes">${escapeHtml(a.notes)}</div>` : ''}
              </div>
              <div class="appt-actions">
                <button class="btn btn-add" data-action="complete-appt" data-id="${a.id}" title="Mark this session complete">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Done
                </button>
                <button class="btn btn-schedule" data-action="toggle-postpone" data-id="${a.id}" title="Postpone — pick a new date and time, the client is notified">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  Postpone
                </button>
                <button class="icon-btn remove-btn" data-action="cancel-appt" data-id="${a.id}" aria-label="Cancel session" title="Cancel session (does not refund the session; recorded in History)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
            ${showPostpone ? `
            <form class="reset-form" data-action="postpone-form" data-id="${a.id}" style="margin-bottom:8px;">
              <label>Reschedule to a new date &amp; time</label>
              <div class="reset-inputs" style="flex-wrap: wrap;">
                <input type="date" id="postpone-date-${a.id}" value="${postponeDateVal}" required style="width:auto; flex:1;" />
                <input type="time" id="postpone-time-${a.id}" value="${postponeTimeVal}" required style="width:auto; flex:1;" />
              </div>
              <div class="reset-inputs">
                <button type="submit" class="btn btn-confirm">Confirm new time</button>
                <button type="button" class="btn btn-cancel" data-action="cancel-postpone">Cancel</button>
              </div>
            </form>` : ''}
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
    scheduleView.querySelectorAll('[data-action="toggle-postpone"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openPostponeId = openPostponeId === btn.dataset.id ? null : btn.dataset.id;
        render();
      });
    });
    scheduleView.querySelectorAll('[data-action="cancel-postpone"]').forEach(btn => {
      btn.addEventListener('click', () => {
        openPostponeId = null;
        render();
      });
    });
    scheduleView.querySelectorAll('[data-action="postpone-form"]').forEach(form => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const appt = appointments.find(a => a.id === id);
        if (!appt) return;
        const dateVal = document.getElementById(`postpone-date-${id}`).value;
        const timeVal = document.getElementById(`postpone-time-${id}`).value;
        if (!dateVal || !timeVal) return;

        const newDatetime = new Date(`${dateVal}T${timeVal}`).toISOString();

        const conflict = findConflict(newDatetime, appt.clientId);
        if (conflict) {
          const conflictClient = clients.find(cl => cl.id === conflict.clientId);
          alert(`${conflictClient ? conflictClient.name : 'Another client'} already has a session around ${formatDateTime(conflict.datetime)}. Pick a different time.`);
          return;
        }

        // Rescheduling just moves the session to a new time — it was
        // already deducted from the client's balance when first booked,
        // so no balance change here.
        appt.datetime = newDatetime;
        openPostponeId = null;
        saveClients();
        render();

        const c = clients.find(cl => cl.id === appt.clientId);
        if (c && c.email) {
          sendSessionNotification(c, newDatetime, appt.notes, 'reschedule', appt.location);
        }
      });
    });
    scheduleView.querySelectorAll('[data-action="cancel-appt"]').forEach(btn => {
      btn.addEventListener('click', () => {
        // Cancelling does not refund the session, and keeps the
        // appointment around (flagged) so it shows up in History.
        const appt = appointments.find(a => a.id === btn.dataset.id);
        if (appt) appt.cancelled = true;
        if (openPostponeId === btn.dataset.id) openPostponeId = null;
        saveClients();
        render();
      });
    });
  }

  function getStatsRange(periodType, anchorDate) {
    let start, end, label;
    if (periodType === 'day') {
      start = new Date(anchorDate); start.setHours(0, 0, 0, 0);
      end = new Date(start); end.setDate(end.getDate() + 1);
      label = start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } else if (periodType === 'month') {
      start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
      end = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1);
      label = start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    } else if (periodType === 'year') {
      start = new Date(anchorDate.getFullYear(), 0, 1);
      end = new Date(anchorDate.getFullYear() + 1, 0, 1);
      label = String(start.getFullYear());
    } else { // week
      start = startOfWeek(anchorDate);
      end = new Date(start); end.setDate(end.getDate() + 7);
      const lastDay = new Date(end); lastDay.setDate(lastDay.getDate() - 1);
      label = `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – `
        + `${lastDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    return { start, end, label };
  }

  function shiftStatsAnchor(periodType, anchorDate, dir) {
    const d = new Date(anchorDate);
    if (periodType === 'day') d.setDate(d.getDate() + dir);
    else if (periodType === 'month') d.setMonth(d.getMonth() + dir);
    else if (periodType === 'year') d.setFullYear(d.getFullYear() + dir);
    else d.setDate(d.getDate() + dir * 7); // week
    return d;
  }

  function renderStatsPanel() {
    const range = getStatsRange(statsPeriodType, statsAnchorDate);
    const inRange = appointments.filter(a => {
      const dt = new Date(a.datetime);
      return dt >= range.start && dt < range.end;
    });
    const bars = [
      { label: 'Pending', count: inRange.filter(a => !a.completed && !a.cancelled).length, color: '#7fa9d1' },
      { label: 'Completed', count: inRange.filter(a => a.completed).length, color: '#7ac298' },
      { label: 'Cancelled', count: inRange.filter(a => a.cancelled).length, color: '#E2857A' },
    ];
    const maxCount = Math.max(bars[0].count, bars[1].count, bars[2].count, 1);

    const chartHeight = 140;
    const barWidth = 64;
    const gap = 40;
    const svgWidth = bars.length * barWidth + (bars.length + 1) * gap;

    const barsHtml = bars.map((b, i) => {
      const x = gap + i * (barWidth + gap);
      const h = Math.max(Math.round((b.count / maxCount) * chartHeight), b.count > 0 ? 2 : 0);
      const y = chartHeight - h;
      return `
        <text x="${x + barWidth / 2}" y="${y - 10}" text-anchor="middle" fill="#F5F3EE" font-family="'JetBrains Mono', monospace" font-size="16" font-weight="700">${b.count}</text>
        <rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="6" fill="${b.color}"></rect>
        <text x="${x + barWidth / 2}" y="${chartHeight + 22}" text-anchor="middle" fill="#8b93a1" font-family="'Inter', sans-serif" font-size="12">${b.label}</text>
      `;
    }).join('');

    const periods = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
    const toggleHtml = periods.map(([key, label]) => `
      <button type="button" class="tab-btn${statsPeriodType === key ? ' active' : ''}" data-action="stats-period" data-period="${key}" style="padding:6px 12px; font-size:11.5px;">${label}</button>
    `).join('');

    return `
      <div class="no-print" style="margin-bottom:26px;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:14px;">
          <div style="display:flex; gap:6px;">${toggleHtml}</div>
          <div class="cal-toolbar" style="margin:0;">
            <button type="button" class="cal-nav-btn" data-action="stats-prev" aria-label="Previous period">‹</button>
            <div class="cal-week-label" style="min-width:auto;">${escapeHtml(range.label)}</div>
            <button type="button" class="cal-nav-btn" data-action="stats-next" aria-label="Next period">›</button>
          </div>
        </div>
        <svg viewBox="0 0 ${svgWidth} ${chartHeight + 40}" style="width:100%; max-width:420px; display:block; margin:0 auto;">
          ${barsHtml}
        </svg>
      </div>
    `;
  }

  function attachStatsListeners() {
    historyView.querySelectorAll('[data-action="stats-period"]').forEach(btn => {
      btn.addEventListener('click', () => {
        statsPeriodType = btn.dataset.period;
        render();
      });
    });
    const prevBtn = historyView.querySelector('[data-action="stats-prev"]');
    if (prevBtn) prevBtn.addEventListener('click', () => {
      statsAnchorDate = shiftStatsAnchor(statsPeriodType, statsAnchorDate, -1);
      render();
    });
    const nextBtn = historyView.querySelector('[data-action="stats-next"]');
    if (nextBtn) nextBtn.addEventListener('click', () => {
      statsAnchorDate = shiftStatsAnchor(statsPeriodType, statsAnchorDate, 1);
      render();
    });
  }

  function downloadButtonHtml() {
    return `
      <div class="no-print" style="display:flex; justify-content:flex-end; margin-bottom:14px;">
        <button type="button" class="btn btn-reset" data-action="download-history-pdf" style="flex:none;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download PDF
        </button>
      </div>
    `;
  }

  function attachDownloadListener() {
    const downloadPdfBtn = historyView.querySelector('[data-action="download-history-pdf"]');
    if (downloadPdfBtn) {
      downloadPdfBtn.addEventListener('click', () => {
        const prevTitle = document.title;
        document.title = `Session Book History ${new Date().toISOString().slice(0, 10)}`;
        window.print();
        document.title = prevTitle;
      });
    }
  }

  function renderHistoryView() {
    const completed = appointments.filter(a => a.completed);
    const cancelled = appointments.filter(a => a.cancelled);
    const allHistory = completed.concat(cancelled);

    if (allHistory.length === 0) {
      historyView.innerHTML = `
        ${downloadButtonHtml()}
        ${renderStatsPanel()}
        <div class="empty-state">No completed or cancelled sessions yet. Sessions marked "Done" or cancelled will show up here.</div>
      `;
      attachDownloadListener();
      attachStatsListeners();
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

    const statsHtml = `
      <div class="appt-row" style="margin-bottom:10px;">
        <div class="appt-info">
          <div class="appt-client">Total completed sessions</div>
        </div>
        <div class="count-num" style="font-size:22px;">${completed.length}</div>
      </div>
      <div class="appt-row" style="margin-bottom:22px;">
        <div class="appt-info">
          <div class="appt-client">Total cancelled sessions</div>
        </div>
        <div class="count-num" style="font-size:22px; color:#E2857A;">${cancelled.length}</div>
      </div>
    `;

    const byClientHtml = summaryOrder.length === 0 ? '' : summaryOrder.map(entry => {
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

    // Group every history entry (completed + cancelled) by month, most
    // recent month first, most recent session first within each month.
    const monthGroups = {};
    const monthOrder = [];
    allHistory
      .slice()
      .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
      .forEach(a => {
        const d = new Date(a.datetime);
        const monthKey = isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        if (!monthGroups[monthKey]) { monthGroups[monthKey] = []; monthOrder.push(monthKey); }
        monthGroups[monthKey].push(a);
      });

    const byMonthHtml = monthOrder.map(monthKey => {
      const rows = monthGroups[monthKey].map(a => {
        const c = clients.find(cl => cl.id === a.clientId);
        const isCancelled = !!a.cancelled;
        return `
          <div class="appt-row">
            <div class="appt-info">
              <div class="appt-client">${c ? escapeHtml(c.name) : 'Unknown client'}</div>
              <div class="appt-notes">${formatDateTime(a.datetime)}${a.location ? ` — ${escapeHtml(a.location)}` : ''}${a.notes ? ` — ${escapeHtml(a.notes)}` : ''}</div>
            </div>
            <div class="next-session" style="color:${isCancelled ? '#E2857A' : '#7ac298'};">${isCancelled ? 'Cancelled' : 'Completed'}</div>
          </div>
        `;
      }).join('');
      return `<div class="schedule-day"><div class="schedule-day-label">${monthKey}</div>${rows}</div>`;
    }).join('');

    historyView.innerHTML = `
      ${downloadButtonHtml()}
      ${renderStatsPanel()}
      ${statsHtml}
      ${byClientHtml ? `<div class="schedule-day-label" style="margin-bottom:10px;">By client</div>${byClientHtml}` : ''}
      <div class="schedule-day-label" style="margin:22px 0 10px;">By month</div>
      ${byMonthHtml}
    `;

    historyView.querySelectorAll('[data-action="toggle-history"]').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        openHistoryClientId = openHistoryClientId === id ? null : id;
        render();
      });
    });

    attachDownloadListener();
    attachStatsListeners();
  }

  function fmtCalHour(h) {
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${period}`;
  }

  function renderCalendarView() {
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(calendarWeekStart);
      d.setDate(calendarWeekStart.getDate() + i);
      weekDays.push(d);
    }
    const todayKey = new Date().toDateString();
    const weekLabel = `${weekDays[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – `
      + `${weekDays[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const hours = [];
    for (let h = CAL_START_HOUR; h <= CAL_END_HOUR; h++) hours.push(h);

    const active = appointments.filter(a => !a.completed && !a.cancelled);

    let headHtml = '<div class="cal-corner"></div>';
    weekDays.forEach(d => {
      const isToday = d.toDateString() === todayKey;
      headHtml += `<div class="cal-day-head${isToday ? ' is-today' : ''}">`
        + `<div class="cal-day-name">${d.toLocaleDateString(undefined, { weekday: 'short' })}</div>`
        + `<div class="cal-day-num">${d.getDate()}</div></div>`;
    });

    let bodyHtml = '';
    hours.forEach(h => {
      bodyHtml += `<div class="cal-time-label">${fmtCalHour(h)}</div>`;
      weekDays.forEach(d => {
        const dayKey = d.toDateString();
        const appt = active.find(a => {
          const ad = new Date(a.datetime);
          return ad.toDateString() === dayKey && ad.getHours() === h;
        });
        if (appt) {
          const c = clients.find(cl => cl.id === appt.clientId);
          const timeStr = new Date(appt.datetime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
          bodyHtml += `<div class="cal-cell"><div class="cal-slot" data-action="cal-open-appt" data-id="${appt.id}">`
            + `<div class="cal-slot-client">${c ? escapeHtml(c.name) : 'Unknown client'}</div>`
            + `<div class="cal-slot-time">${timeStr}</div></div></div>`;
        } else {
          const pad = n => String(n).padStart(2, '0');
          const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          const timeStr = `${pad(h)}:00`;
          bodyHtml += `<div class="cal-cell" data-action="cal-open-slot" data-date="${dateStr}" data-time="${timeStr}"></div>`;
        }
      });
    });

    calendarView.innerHTML = `
      <div class="cal-toolbar">
        <button type="button" class="cal-nav-btn" data-action="cal-prev" aria-label="Previous week">‹</button>
        <button type="button" class="btn btn-reset" data-action="cal-today" style="flex:none; padding:6px 14px;">Today</button>
        <div class="cal-week-label">${weekLabel}</div>
        <button type="button" class="cal-nav-btn" data-action="cal-next" aria-label="Next week">›</button>
      </div>
      <div class="cal-wrap"><div class="cal-grid">${headHtml}${bodyHtml}</div></div>
      <div class="legend">
        <div class="legend-item"><span class="legend-swatch booked"></span>Booked</div>
        <div class="legend-item"><span class="legend-swatch open"></span>Open — click to schedule</div>
      </div>
    `;

    attachCalendarListeners();
  }

  function attachCalendarListeners() {
    calendarView.querySelector('[data-action="cal-prev"]').addEventListener('click', () => {
      calendarWeekStart.setDate(calendarWeekStart.getDate() - 7);
      render();
    });
    calendarView.querySelector('[data-action="cal-next"]').addEventListener('click', () => {
      calendarWeekStart.setDate(calendarWeekStart.getDate() + 7);
      render();
    });
    calendarView.querySelector('[data-action="cal-today"]').addEventListener('click', () => {
      calendarWeekStart = startOfWeek(new Date());
      render();
    });
    calendarView.querySelectorAll('[data-action="cal-open-appt"]').forEach(el => {
      el.addEventListener('click', () => {
        const apptId = el.dataset.id;
        setView('schedule');
        const row = scheduleView.querySelector(`[data-appt-id="${apptId}"]`);
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('appt-highlight');
          setTimeout(() => row.classList.remove('appt-highlight'), 1600);
        }
      });
    });
    calendarView.querySelectorAll('[data-action="cal-open-slot"]').forEach(el => {
      el.addEventListener('click', () => {
        calPendingSlot = { date: el.dataset.date, time: el.dataset.time };
        openCalClientPicker();
      });
    });
  }

  function openCalClientPicker() {
    const slotDate = new Date(`${calPendingSlot.date}T${calPendingSlot.time}`);
    document.getElementById('calPickTimeLabel').textContent = isNaN(slotDate.getTime())
      ? ''
      : slotDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
        + ' · ' + slotDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const calClientList = document.getElementById('calClientList');
    if (clients.length === 0) {
      calClientList.innerHTML = `<div class="next-session" style="color:#8b93a1;">No clients yet — add one from the Clients tab first.</div>`;
    } else {
      calClientList.innerHTML = clients.map(c => `
        <button type="button" class="btn btn-schedule" style="justify-content:space-between; flex:none;" data-action="cal-pick-client" data-id="${c.id}">
          <span>${escapeHtml(c.name)}</span>
          <span style="font-family:'JetBrains Mono',monospace; font-size:12px;">${c.sessions} left</span>
        </button>
      `).join('');
      calClientList.querySelectorAll('[data-action="cal-pick-client"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const clientId = btn.dataset.id;
          const c = clients.find(cl => cl.id === clientId);
          if (c && c.sessions <= 0) {
            alert(`${c.name} has no sessions remaining. Add sessions before scheduling one.`);
            return;
          }
          document.getElementById('calPickClientOverlay').classList.add('hidden');
          openScheduleId = clientId;
          setView('clients');
          const dateInput = document.getElementById(`sched-date-${clientId}`);
          const timeInput = document.getElementById(`sched-time-${clientId}`);
          if (dateInput && calPendingSlot) dateInput.value = calPendingSlot.date;
          if (timeInput && calPendingSlot) timeInput.value = calPendingSlot.time;
          bindLocationAutocomplete(document.getElementById(`sched-location-${clientId}`));
          calPendingSlot = null;
        });
      });
    }
    document.getElementById('calPickClientOverlay').classList.remove('hidden');
  }

  document.getElementById('closeCalPickBtn').addEventListener('click', () => {
    document.getElementById('calPickClientOverlay').classList.add('hidden');
    calPendingSlot = null;
  });
  document.getElementById('calPickClientOverlay').addEventListener('click', (e) => {
    const overlayEl = document.getElementById('calPickClientOverlay');
    if (e.target === overlayEl) {
      overlayEl.classList.add('hidden');
      calPendingSlot = null;
    }
  });

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
            <input type="email" id="edit-email-${c.id}" value="${escapeHtml(c.email || '')}" placeholder="client@example.com" required style="width:auto; flex:1;" />
          </div>
          <div class="reset-inputs">
            <input type="tel" id="edit-phone-${c.id}" value="${escapeHtml(c.phone || '')}" placeholder="082 123 4567" required style="width:auto; flex:1;" />
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
          <div class="reset-inputs" style="position:relative;">
            <input type="text" id="sched-location-${c.id}" placeholder="Location (optional)" autocomplete="off" style="width:auto; flex:1;" />
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
        const pending = appointments.filter(a => a.clientId === id && !a.completed && !a.cancelled);
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
        if (!name || !email || !phone) return;
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
        if (openScheduleId) {
          bindLocationAutocomplete(document.getElementById(`sched-location-${openScheduleId}`));
        }
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
        const locationVal = document.getElementById(`sched-location-${id}`).value.trim();
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
          alert(`${conflictClient ? conflictClient.name : 'Another client'} already has a session around ${formatDateTime(conflict.datetime)}. Pick a different time.`);
          return;
        }

        appointments.push({
          id: 'a' + Date.now(),
          clientId: id,
          datetime,
          notes: notesVal,
          location: locationVal,
          completed: false,
        });
        // Scheduling reserves a session against the client's remaining balance.
        if (c) c.sessions = Math.max(0, c.sessions - 1);
        openScheduleId = null;
        saveClients();
        render();

        if (c && c.email) {
          sendSessionNotification(c, datetime, notesVal, 'booking', locationVal);
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
      if (a.completed || a.cancelled) return false;
      if (a.clientId === excludeClientId) return false;
      const t = new Date(a.datetime).getTime();
      return Math.abs(t - target) < SESSION_DURATION_MINUTES * 60000;
    }) || null;
  }

  // Fire-and-forget: let the trainer know if it fails, but don't block
  // the scheduling flow on it. `type` is 'booking' (default) or
  // 'reschedule', which changes the email's subject/wording server-side.
  function sendSessionNotification(client, datetimeIso, notes, type, location) {
    const url = getBackendUrl();
    if (!url || !auth) return;
    const q = '?action=notifyBooking&token=' + encodeURIComponent(auth.token)
      + '&email=' + encodeURIComponent(client.email)
      + '&clientName=' + encodeURIComponent(client.name)
      + '&datetime=' + encodeURIComponent(datetimeIso)
      + '&notes=' + encodeURIComponent(notes || '')
      + '&type=' + encodeURIComponent(type || 'booking')
      + '&location=' + encodeURIComponent(location || '');
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
    if (!name || !email || !phone || Number.isNaN(sessions) || sessions < 0) return;
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

  // ---- Trainer profile ----
  const profileOverlay = document.getElementById('profileOverlay');
  const profileForm = document.getElementById('profileForm');
  const profileStatus = document.getElementById('profileStatus');

  document.getElementById('profileBtn').addEventListener('click', () => {
    profileOverlay.classList.remove('hidden');
    profileStatus.textContent = 'Loading…';
    document.getElementById('profileEmail').value = auth.email || '';
    const url = getBackendUrl();
    if (!url || !auth) return;
    fetch(url + '?action=getProfile&token=' + encodeURIComponent(auth.token))
      .then(res => res.json())
      .then(data => {
        if (data && data.success) {
          document.getElementById('profileCompanyName').value = data.companyName || '';
          document.getElementById('profilePhone').value = data.phone || '';
          profileStatus.textContent = '';
        } else {
          profileStatus.textContent = (data && data.error) || 'Could not load profile';
        }
      })
      .catch(() => { profileStatus.textContent = 'Network error — check your connection'; });
  });
  document.getElementById('closeProfileBtn').addEventListener('click', () => {
    profileOverlay.classList.add('hidden');
  });
  profileOverlay.addEventListener('click', (e) => {
    if (e.target === profileOverlay) profileOverlay.classList.add('hidden');
  });

  profileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const companyName = document.getElementById('profileCompanyName').value.trim();
    const phone = document.getElementById('profilePhone').value.trim();
    if (!companyName || !phone) return;
    const url = getBackendUrl();
    if (!url || !auth) return;
    profileStatus.textContent = 'Saving…';
    const q = '?action=updateProfile&token=' + encodeURIComponent(auth.token)
      + '&companyName=' + encodeURIComponent(companyName)
      + '&phone=' + encodeURIComponent(phone);
    fetch(url + q)
      .then(res => res.json())
      .then(data => {
        if (data && data.success) {
          profileStatus.textContent = 'Saved.';
          setTimeout(() => { profileOverlay.classList.add('hidden'); }, 500);
        } else {
          profileStatus.textContent = (data && data.error) || 'Could not save profile';
        }
      })
      .catch(() => { profileStatus.textContent = 'Network error — check your connection'; });
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