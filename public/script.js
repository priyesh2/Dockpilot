// ===== DockPilot v2.0 — 20 Features Edition =====
const originalFetch = window.fetch;
let isLogPaused = false;
window.fetch = async (...args) => {
    let [resource, config] = args;
    config = config || {};
    config.headers = config.headers || {};
    const token = localStorage.getItem('docker_jwt');
    if (token && typeof resource === 'string' && resource.startsWith('/api/')) {
        config.headers['Authorization'] = `Bearer ${token}`;
    }
    try {
        const res = await originalFetch(resource, config);
        if (res.status === 401 && resource !== '/api/login') {
            document.getElementById('login-overlay').style.display = 'flex';
        }
        return res;
    } catch (err) { console.error(`Fetch error [${resource}]:`, err); throw err; }
};

// ===== TOAST =====
let toastOffset = 20;
const showToast = (msg, isError = false) => {
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = msg;
    const top = toastOffset; toastOffset += 50;
    toast.style.cssText = `position:fixed;top:${top}px;right:20px;padding:12px 20px;border-radius:8px;z-index:99999;color:white;font-size:13px;transition:opacity 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.3);background:${isError ? 'var(--red,#ff0055)' : 'var(--green,#39ff14)'};`;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toastOffset -= 50; setTimeout(() => toast.remove(), 300); }, 3000);
};

// ===== LOGIN =====
document.getElementById('btn-login').onclick = async () => {
    const username = document.getElementById('login-username').value || 'admin';
    const password = document.getElementById('login-password').value;
    const res = await originalFetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    if (res.ok) {
        const data = await res.json();
        localStorage.setItem('docker_jwt', data.token);
        localStorage.setItem('docker_role', data.role);
        localStorage.setItem('docker_username', data.username || username);
        localStorage.setItem('docker_login_time', Date.now().toString());
        document.getElementById('login-overlay').style.display = 'none';
        applyRoleConstraints(); initSession(); fetchContainers(); fetchDashboardStats();
    } else {
        const errorDiv = document.getElementById('login-error');
        errorDiv.textContent = 'Invalid username or password'; errorDiv.style.display = 'block';
    }
};

const socket = io({ autoConnect: false, auth: (cb) => cb({ token: localStorage.getItem('docker_jwt') }) });
let activeContainerId = null;
let containersData = [];
let containerInspectCache = {};
let autoScroll = true;
let notificationsData = [];

// ===== ROLE =====
const applyRoleConstraints = () => {
    const role = localStorage.getItem('docker_role');
    document.querySelectorAll('.admin-only').forEach(el => {
        if (role !== 'admin') el.style.setProperty('display', 'none', 'important');
        else el.style.removeProperty('display');
    });
};

// ===== SESSION TIMEOUT =====
let sessionInterval = null;
const initSession = () => {
    const username = localStorage.getItem('docker_username') || 'admin';
    const si = document.getElementById('session-info');
    if (si) si.style.display = 'flex';
    const avatar = document.getElementById('user-avatar');
    if (avatar) avatar.textContent = username[0].toUpperCase();
    const uname = document.getElementById('session-username');
    if (uname) uname.textContent = username;
    clearInterval(sessionInterval);
    sessionInterval = setInterval(() => {
        const loginTime = parseInt(localStorage.getItem('docker_login_time') || '0');
        const elapsed = Date.now() - loginTime;
        const remaining = Math.max(0, 24 * 3600 * 1000 - elapsed);
        if (remaining <= 0) { localStorage.clear(); location.reload(); return; }
        const h = Math.floor(remaining / 3600000);
        const m = Math.floor((remaining % 3600000) / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        const el = document.getElementById('session-timer');
        if (el) el.textContent = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }, 1000);
};

// ===== THEME =====
const setTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('docker_theme', theme);
    document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === theme));
};
document.querySelectorAll('.theme-dot').forEach(d => d.onclick = () => setTheme(d.dataset.theme));
setTheme(localStorage.getItem('docker_theme') || 'cyberpunk');

// ===== DASHBOARD STATS =====
const fetchDashboardStats = async () => {
    try {
        const res = await fetch('/api/dashboard/stats');
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('host-os').textContent = data.operatingSystem || 'Linux';
        document.getElementById('total-containers').textContent = data.containersTotal;
        document.getElementById('total-images').textContent = data.imagesTotal;
        document.getElementById('total-mem').textContent = data.memTotal;
        document.getElementById('total-cpu').textContent = data.ncpu;
        renderDashboardOverview(data);
    } catch {}
};

const renderDashboardOverview = (data) => {
    const el = document.getElementById('welcome-message');
    if (!el || activeContainerId) return;
    el.innerHTML = `<div class="dashboard-overview">
        <div class="dashboard-title"><span class="dock-icon">🐳</span><h2>Dock<span style="color:var(--accent-color)">Pilot</span> Dashboard</h2><p>Enterprise Container Management v2.0</p></div>
        <div class="stat-cards">
            <div class="stat-card"><div class="stat-icon">🟢</div><div class="stat-value">${data.containersRunning||0}</div><div class="stat-label">Running</div></div>
            <div class="stat-card"><div class="stat-icon">🔴</div><div class="stat-value">${data.containersStopped||0}</div><div class="stat-label">Stopped</div></div>
            <div class="stat-card"><div class="stat-icon">🐳</div><div class="stat-value">${data.containersTotal||0}</div><div class="stat-label">Total Containers</div></div>
            <div class="stat-card"><div class="stat-icon">📀</div><div class="stat-value">${data.imagesTotal||0}</div><div class="stat-label">Images</div></div>
            <div class="stat-card"><div class="stat-icon">💾</div><div class="stat-value">${data.volumesTotal||0}</div><div class="stat-label">Volumes</div></div>
            <div class="stat-card"><div class="stat-icon">🌐</div><div class="stat-value">${data.networksTotal||0}</div><div class="stat-label">Networks</div></div>
            <div class="stat-card"><div class="stat-icon">🧠</div><div class="stat-value">${data.memTotal||0}</div><div class="stat-label">GB Memory</div></div>
            <div class="stat-card"><div class="stat-icon">💻</div><div class="stat-value">${data.ncpu||0}</div><div class="stat-label">CPU Cores</div></div>
        </div>
        <div class="dashboard-row">
            <div class="dashboard-chart-card"><h3>Health Distribution</h3><div style="height:200px;display:flex;align-items:center;justify-content:center;"><canvas id="healthDoughnut"></canvas></div></div>
            <div class="dashboard-activity-card"><h3>Recent Activity</h3><div id="dash-activity-list">${(data.recentActivity||[]).map(a=>`<div class="dash-activity-item"><div><span class="da-action">${a.action}</span> ${a.details||''}</div><span class="da-time">${new Date(a.time).toLocaleTimeString()}</span></div>`).join('')||'<div style="color:var(--text-secondary);font-size:12px;padding:10px;">No recent activity</div>'}</div></div>
        </div>
    </div>`;
    // Health chart
    const hd = data.healthDistribution || {};
    try {
        const ctx = document.getElementById('healthDoughnut');
        if (ctx) new Chart(ctx, { type:'doughnut', data: { labels:['Healthy','Unhealthy','Starting','No Check'], datasets:[{data:[hd.healthy||0,hd.unhealthy||0,hd.starting||0,hd.noHealthcheck||0], backgroundColor:['#39ff14','#ff0055','#ffea00','#555'], borderWidth:0}] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom',labels:{color:'#8b8ba0',font:{size:11}}}}} });
    } catch {}
};

// ===== NOTIFICATIONS =====
const notifBell = document.getElementById('notification-bell');
const notifDropdown = document.getElementById('notification-dropdown');
const notifCount = document.getElementById('notification-count');
const notifList = document.getElementById('notification-list');

notifBell.onclick = (e) => { e.stopPropagation(); notifDropdown.classList.toggle('show'); };
document.addEventListener('click', () => notifDropdown.classList.remove('show'));
notifDropdown.onclick = (e) => e.stopPropagation();

document.getElementById('btn-mark-read').onclick = async () => {
    try { await fetch('/api/notifications/read', { method: 'POST' }); } catch {}
    notificationsData.forEach(n => n.read = true);
    renderNotifications();
};

const addNotification = (entry) => {
    notificationsData.unshift({ ...entry, id: Date.now(), read: false });
    if (notificationsData.length > 50) notificationsData.pop();
    renderNotifications();
    notifBell.classList.add('has-unread');
    setTimeout(() => notifBell.classList.remove('has-unread'), 1500);
};

const renderNotifications = () => {
    const unread = notificationsData.filter(n => !n.read).length;
    notifCount.style.display = unread > 0 ? 'flex' : 'none';
    notifCount.textContent = unread;
    if (notificationsData.length === 0) { notifList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:12px;">No notifications</div>'; return; }
    notifList.innerHTML = notificationsData.slice(0,20).map(n => `<div class="notification-item ${n.read?'':'unread'}"><div class="notif-time">${new Date(n.time).toLocaleString()}</div><div><span class="notif-action">${n.action}</span> <span class="notif-detail">${n.details||''}</span></div></div>`).join('');
};

// Listen for real-time notifications via socket
socket.on('notification', (entry) => addNotification(entry));

// Fetch initial notifications
(async () => { try { const r = await fetch('/api/notifications'); if(r.ok) { notificationsData = await r.json(); renderNotifications(); } } catch {} })();

// ===== DOM REFS =====
const containerList = document.getElementById('container-list');
const searchInput = document.getElementById('container-search');
const logViewer = document.getElementById('log-viewer');
const logsContent = document.getElementById('logs');
const logHeader = document.getElementById('log-header');
const logFooter = document.getElementById('log-footer');
const welcomeMessage = document.getElementById('welcome-message');
const statCpu = document.getElementById('stat-cpu');
const statMem = document.getElementById('stat-mem');
const containerStats = document.getElementById('container-stats');
const imagesView = document.getElementById('images-view');
const logViewerWrapper = document.getElementById('log-viewer-wrapper');
const usersView = document.getElementById('users-view');
const maintenanceView = document.getElementById('maintenance-view');
const activityView = document.getElementById('activity-view');
const volumesView = document.getElementById('volumes-view');
const networksView = document.getElementById('networks-view');
const sysmonitorView = document.getElementById('sysmonitor-view');
let selectedContainers = new Set();
const bulkActions = document.getElementById('bulk-actions');
const bulkCount = document.getElementById('bulk-count');
const selectAllCheckbox = document.getElementById('select-all-containers');

const updateBulkUI = () => {
    bulkCount.textContent = selectedContainers.size;
    bulkActions.style.display = selectedContainers.size > 0 ? 'flex' : 'none';
    selectAllCheckbox.checked = containersData.length > 0 && selectedContainers.size === containersData.length;
};

// ===== CHARTS =====
let cpuChart, memChart, cpuData = [], memData = [], labels = [];
const initCharts = () => {
    cpuChart = new Chart(document.getElementById('cpuChart').getContext('2d'), { type:'line', data:{labels,datasets:[{label:'CPU %',data:cpuData,borderColor:'#58a6ff',tension:0.4}]}, options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true}}} });
    memChart = new Chart(document.getElementById('memChart').getContext('2d'), { type:'line', data:{labels,datasets:[{label:'Memory MB',data:memData,borderColor:'#da3633',tension:0.4}]}, options:{responsive:true,maintainAspectRatio:false,scales:{y:{beginAtZero:true}}} });
};
initCharts();

// ===== TERMINAL =====
const term = new Terminal({ theme:{background:'#000',foreground:'#eff0eb'}, fontFamily:'"Fira Code",monospace', fontSize:14, cursorBlink:true });
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-viewer'));
term.onData(data => socket.emit('exec-input', data));
socket.on('exec-output', data => term.write(data));
window.addEventListener('resize', () => { if(document.getElementById('terminal-viewer').style.display!=='none'){fitAddon.fit();socket.emit('exec-resize',{cols:term.cols,rows:term.rows});} });

// ===== UPTIME HELPER =====
const formatUptime = (startedAt) => {
    if (!startedAt) return '';
    const start = new Date(startedAt);
    if (isNaN(start.getTime())) return '';
    const diff = Date.now() - start.getTime();
    if (diff < 0) return '';
    const mins = Math.floor(diff/60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins/60);
    if (hrs < 24) return `${hrs}h ${mins%60}m`;
    const days = Math.floor(hrs/24);
    return `${days}d ${hrs%24}h`;
};

// ===== CONTAINER TOOLTIP =====
const tooltip = document.getElementById('container-tooltip');
let tooltipTimeout = null;

const showTooltip = async (containerId, e) => {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(async () => {
        try {
            let info = containerInspectCache[containerId];
            if (!info) {
                const res = await fetch(`/api/containers/${containerId}/inspect`);
                if (!res.ok) return;
                info = await res.json();
                containerInspectCache[containerId] = info;
                setTimeout(() => delete containerInspectCache[containerId], 30000);
            }
            const ports = info.NetworkSettings?.Ports || {};
            const portStr = Object.entries(ports).filter(([,v])=>v).map(([k,v])=>`${v[0]?.HostPort||'?'}→${k}`).join(', ') || 'None';
            const ip = info.NetworkSettings?.IPAddress || 'N/A';
            const restarts = info.RestartCount || 0;
            const uptime = info.State?.Running ? formatUptime(info.State.StartedAt) : 'Stopped';
            const health = info.State?.Health?.Status || 'none';
            tooltip.innerHTML = `<h4>${(info.Name||'').replace('/','')}</h4>
                <div class="tt-row"><span class="tt-label">Image</span><span class="tt-value">${info.Config?.Image||'?'}</span></div>
                <div class="tt-row"><span class="tt-label">Status</span><span class="tt-value">${info.State?.Status||'?'}</span></div>
                <div class="tt-row"><span class="tt-label">Uptime</span><span class="tt-value">${uptime}</span></div>
                <div class="tt-row"><span class="tt-label">Ports</span><span class="tt-value">${portStr}</span></div>
                <div class="tt-row"><span class="tt-label">IP</span><span class="tt-value">${ip}</span></div>
                <div class="tt-row"><span class="tt-label">Restarts</span><span class="tt-value">${restarts}</span></div>
                <div class="tt-row"><span class="tt-label">Health</span><span class="tt-value">${health}</span></div>`;
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = Math.min(e.clientY, window.innerHeight - 250) + 'px';
        } catch {}
    }, 400);
};

const hideTooltip = () => { clearTimeout(tooltipTimeout); tooltip.style.display = 'none'; };

// ===== CONTAINER NOTES (localStorage) =====
const getNotes = () => { try { return JSON.parse(localStorage.getItem('dock_notes')||'{}'); } catch { return {}; } };
const saveNote = (id, text) => { const n = getNotes(); n[id] = text; localStorage.setItem('dock_notes', JSON.stringify(n)); };

// ===== CONTAINER TAGS (localStorage) =====
const getTags = () => { try { return JSON.parse(localStorage.getItem('dock_tags')||'{}'); } catch { return {}; } };

// ===== RENDER CONTAINERS =====
let isFetchingContainers = false;
const fetchContainers = async () => {
    if (isFetchingContainers) return;
    isFetchingContainers = true;
    try {
        const res = await fetch('/api/containers');
        containersData = await res.json();
        renderContainers();
    } catch (e) { console.error("Failed to fetch containers", e); }
    finally { isFetchingContainers = false; }
};

const renderContainers = () => {
    const filter = searchInput.value.toLowerCase();
    const statusVal = document.getElementById('status-filter').value;
    containerList.innerHTML = '';

    // Group by compose project (stack)
    const stacks = {};
    const ungrouped = [];
    containersData.filter(c => {
        const name = c.Names[0].replace('/','');
        const matchesSearch = name.toLowerCase().includes(filter) || c.Image.toLowerCase().includes(filter);
        const matchesStatus = statusVal === 'all' || c.State === statusVal;
        return matchesSearch && matchesStatus;
    }).forEach(c => {
        const project = c.Labels?.['com.docker.compose.project'];
        if (project) { (stacks[project] = stacks[project] || []).push(c); }
        else ungrouped.push(c);
    });

    const renderItem = (c) => {
        const name = c.Names[0].replace('/','');
        const state = c.State;
        const li = document.createElement('li');
        li.className = `container-item ${c.Id === activeContainerId ? 'active' : ''}`;
        li.onclick = () => selectContainer(c.Id, name, state);
        li.onmouseenter = (e) => showTooltip(c.Id, e);
        li.onmouseleave = hideTooltip;

        const cb = document.createElement('input');
        cb.type='checkbox'; cb.className='container-checkbox'; cb.checked=selectedContainers.has(c.Id);
        cb.onclick = (e) => { e.stopPropagation(); if(e.target.checked) selectedContainers.add(c.Id); else selectedContainers.delete(c.Id); updateBulkUI(); };

        const dot = document.createElement('div');
        dot.className = `status-dot ${state}`;

        const info = document.createElement('div');
        info.className = 'container-info-list';

        // Port badges
        const ports = c.Ports || [];
        const portBadges = ports.filter(p=>p.PublicPort).map(p=>`<span class="micro-badge port-badge" onclick="event.stopPropagation();window.open('http://localhost:${p.PublicPort}','_blank')" title="Open localhost:${p.PublicPort}">${p.PublicPort}→${p.PrivatePort}</span>`).join('');

        // Health badge
        const healthLabel = c.Status && c.Status.includes('healthy') ? (c.Status.includes('unhealthy') ? 'unhealthy' : 'healthy') : '';
        const healthBadge = healthLabel ? `<span class="micro-badge health-badge health-${healthLabel}">${healthLabel}</span>` : '';

        // Uptime
        const uptimeStr = state === 'running' ? c.Status || '' : '';

        info.innerHTML = `<div class="container-name">${name}</div><div class="container-image">${c.Image}</div><div class="container-meta-badges">${portBadges}${healthBadge}</div>${uptimeStr?`<div class="container-uptime">⏱ ${uptimeStr}</div>`:''}`;

        li.appendChild(cb); li.appendChild(dot); li.appendChild(info);
        return li;
    };

    // Render stacks
    Object.entries(stacks).forEach(([project, containers]) => {
        const group = document.createElement('div');
        group.className = 'stack-group';
        const collapsed = localStorage.getItem(`stack_${project}`) === 'collapsed';
        group.innerHTML = `<div class="stack-group-header"><span class="stack-arrow ${collapsed?'collapsed':''}">▼</span> 📦 ${project} (${containers.length})</div>`;
        const body = document.createElement('div');
        body.className = `stack-group-body ${collapsed?'collapsed':''}`;
        containers.forEach(c => body.appendChild(renderItem(c)));
        group.querySelector('.stack-group-header').onclick = () => {
            body.classList.toggle('collapsed');
            group.querySelector('.stack-arrow').classList.toggle('collapsed');
            localStorage.setItem(`stack_${project}`, body.classList.contains('collapsed')?'collapsed':'expanded');
        };
        group.appendChild(body);
        containerList.appendChild(group);
    });

    ungrouped.forEach(c => containerList.appendChild(renderItem(c)));

    // Sync active container state
    if (activeContainerId) {
        const ac = containersData.find(c => c.Id === activeContainerId);
        if (ac) {
            const sb = document.getElementById('current-container-status');
            sb.textContent = ac.State.toUpperCase();
            sb.className = `status-badge ${ac.State}`;
            containerStats.style.display = ac.State === 'running' ? 'flex' : 'none';
        }
    }
    updateBulkUI();
};

document.getElementById('status-filter').onchange = renderContainers;
searchInput.addEventListener('input', renderContainers);
selectAllCheckbox.addEventListener('change', (e) => {
    if (e.target.checked) { containersData.forEach(c => selectedContainers.add(c.Id)); }
    else selectedContainers.clear();
    renderContainers();
});

// ===== VIEW TABS =====
const views = {
    'logs': document.getElementById('log-viewer'),
    'env': document.getElementById('env-viewer'),
    'files': document.getElementById('files-viewer'),
    'diff': document.getElementById('diff-viewer'),
    'terminal': document.getElementById('terminal-viewer-wrapper'),
    'stats': document.getElementById('stats-viewer'),
    'raw': document.getElementById('raw-viewer')
};

document.querySelectorAll('.btn-quick-exec').forEach(btn => {
    btn.onclick = (e) => socket.emit('exec-input', e.target.dataset.cmd + '\n');
});

function switchTab(viewName) {
    Object.values(views).forEach(v => v.style.display = 'none');
    views[viewName].style.display = (viewName === 'stats' || viewName === 'logs' || viewName === 'env') ? 'flex' : 'block';
    if (viewName === 'terminal') {
        setTimeout(() => { fitAddon.fit(); socket.emit('exec-start', { Cmd:['/bin/sh'], AttachStdin:true, AttachStdout:true, AttachStderr:true, Tty:true }); setTimeout(() => socket.emit('exec-resize', { cols:term.cols, rows:term.rows }), 200); }, 100);
    }
    logFooter.style.display = (viewName === 'logs') ? 'flex' : 'none';
    if (viewName === 'env' && activeContainerId) fetchEnvVars();
    if (viewName === 'files' && activeContainerId) fetchFiles('/');
    if (viewName === 'diff' && activeContainerId) fetchDiff();
    if (viewName === 'raw' && activeContainerId) fetchRawInspect();
    if (viewName === 'logs' && autoScroll) setTimeout(() => { logsContent.scrollTop = logsContent.scrollHeight; }, 100);
    if (viewName === 'stats' && cpuChart) setTimeout(() => { cpuChart.update(); memChart.update(); }, 100);
}

document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active'); switchTab(e.target.dataset.view);
    });
});

// ===== SHOW MAIN VIEW =====
const allPanels = () => [imagesView, usersView, maintenanceView, activityView, volumesView, networksView, sysmonitorView, logViewerWrapper].filter(Boolean);

const showMainView = (viewEl) => {
    allPanels().forEach(el => el.style.display = 'none');
    welcomeMessage.style.display = 'none';
    const topTitle = document.getElementById('top-context-title');
    if (viewEl === logViewerWrapper) {
        viewEl.style.display = 'flex';
        if (!activeContainerId) {
            welcomeMessage.style.display = 'block';
            logHeader.style.display = 'none';
            topTitle.textContent = 'Dashboard Overview';
            Object.values(views).forEach(v => v && (v.style.display = 'none'));
            if (logFooter) logFooter.style.display = 'none';
            fetchDashboardStats();
        } else { logHeader.style.display = 'flex'; }
    } else {
        viewEl.style.display = 'flex'; logHeader.style.display = 'none';
        const titles = { [imagesView?.id]:'Docker Images', [usersView?.id]:'User Management', [activityView?.id]:'Activity Audit Log', [maintenanceView?.id]:'System Maintenance', [volumesView?.id]:'Volume Management', [networksView?.id]:'Network Management', [sysmonitorView?.id]:'System Resource Monitor' };
        topTitle.textContent = titles[viewEl.id] || 'Dashboard';
    }
};

// Nav bindings
document.getElementById('nav-images').onclick = () => { showMainView(imagesView); fetchImages(); };
document.getElementById('btn-close-images').onclick = () => showMainView(logViewerWrapper);
document.getElementById('nav-users').onclick = () => { showMainView(usersView); fetchUsers(); };
document.getElementById('btn-close-users').onclick = () => showMainView(logViewerWrapper);
document.getElementById('nav-maintenance').onclick = () => showMainView(maintenanceView);
document.getElementById('btn-close-maintenance').onclick = () => showMainView(logViewerWrapper);
document.getElementById('nav-activity').onclick = () => { showMainView(activityView); fetchActivity(); };
document.getElementById('btn-close-activity').onclick = () => showMainView(logViewerWrapper);
document.getElementById('nav-volumes').onclick = () => { showMainView(volumesView); fetchVolumes(); };
document.getElementById('btn-close-volumes').onclick = () => showMainView(logViewerWrapper);
document.getElementById('nav-networks').onclick = () => { showMainView(networksView); fetchNetworksPanel(); };
document.getElementById('btn-close-networks').onclick = () => showMainView(logViewerWrapper);
document.getElementById('nav-sysmonitor').onclick = () => { showMainView(sysmonitorView); fetchSysMonitor(); };
document.getElementById('btn-close-sysmonitor').onclick = () => showMainView(logViewerWrapper);
document.getElementById('btn-close-container').addEventListener('click', () => { activeContainerId=null; showMainView(logViewerWrapper); renderContainers(); });

// ===== DATA FETCHERS =====
const fetchRawInspect = async () => { const el=document.getElementById('raw-inspect-content'); el.textContent='Loading...'; try { const r=await fetch(`/api/containers/${activeContainerId}/inspect`); el.textContent=JSON.stringify(await r.json(),null,2); } catch { el.textContent='Error'; } };

let currentPath = '/';
const fetchFiles = async (path) => { currentPath=path; document.getElementById('files-path').textContent=path; const list=document.getElementById('files-list'); list.innerHTML='Loading...'; try { const r=await fetch(`/api/containers/${activeContainerId}/files?path=${encodeURIComponent(path)}`); const data=await r.json(); list.innerHTML=''; data.files.forEach(f=>{ const row=document.createElement('div'); row.className='file-row'; row.innerHTML=`<span style="cursor:${f.isDir?'pointer':'default'};color:${f.isDir?'var(--accent-color)':'var(--text-primary)'}">${f.isDir?'📁':'📄'} ${f.name}</span><span style="color:var(--text-secondary);font-size:11px;">${f.size} | ${f.perms}</span>`; if(f.isDir) row.onclick=()=>fetchFiles(currentPath==='/'?`/${f.name}`:`${currentPath}/${f.name}`); list.appendChild(row); }); } catch { list.innerHTML='Error loading files'; } };
document.getElementById('btn-files-up').onclick = () => { if(currentPath==='/') return; const p=currentPath.split('/').filter(p=>p); p.pop(); fetchFiles('/'+p.join('/')); };

const fetchDiff = async () => { const list=document.getElementById('diff-list'); list.innerHTML='Loading...'; try { const r=await fetch(`/api/containers/${activeContainerId}/diff`); const data=await r.json(); list.innerHTML=''; if(!data.length) list.innerHTML='<div style="color:var(--text-secondary)">No changes</div>'; data.forEach(c=>{ const row=document.createElement('div'); const t=['MOD','ADD','DEL'][c.Kind]||'?'; const col=['var(--yellow)','var(--green)','var(--red)'][c.Kind]||'white'; row.innerHTML=`<span style="color:${col};width:40px;display:inline-block">${t}</span> ${c.Path}`; list.appendChild(row); }); } catch { list.innerHTML='Error'; } };

const fetchEnvVars = async () => { const list=document.getElementById('env-list'); list.innerHTML='Loading...'; try { const r=await fetch(`/api/containers/${activeContainerId}/inspect`); const data=await r.json(); list.innerHTML=''; (data.Config.Env||[]).forEach(env=>{ const [key,...val]=env.split('='); const row=document.createElement('div'); row.style.cssText='background:var(--bg-dark);padding:8px 12px;border-radius:4px;border:1px solid var(--border-color);font-size:12px;'; row.innerHTML=`<span style="color:var(--accent-color);font-weight:600;">${key}</span> = <span style="color:var(--text-primary);">${val.join('=')}</span>`; list.appendChild(row); }); } catch {} };

const fetchVolumes = async () => { try { const r=await fetch('/api/volumes'); const vols=await r.json(); const g=document.getElementById('volumes-grid'); g.innerHTML=''; vols.forEach(v=>{ const c=document.createElement('div'); c.className='image-card'; c.innerHTML=`<h4>${v.Name.substring(0,24)}${v.Name.length>24?'...':''}</h4><div class="image-meta"><div>Driver: ${v.Driver}</div><div style="font-size:10px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${v.Mountpoint}">${v.Mountpoint}</div></div><div class="image-card-actions"><button class="btn btn-sm bg-red" style="color:white;border-color:var(--red);" onclick="deleteVolume('${v.Name}')">Delete</button></div>`; g.appendChild(c); }); } catch {} };
window.deleteVolume = async (name) => { try { const r=await fetch(`/api/volumes/${encodeURIComponent(name)}`,{method:'DELETE'}); const d=await r.json(); if(!r.ok) throw new Error(d.error); showToast(d.message); fetchVolumes(); } catch(e) { showToast(e.message,true); } };
document.getElementById('btn-create-volume').onclick = async () => { const name=document.getElementById('new-volume-name').value.trim(); if(!name) return; try { const r=await fetch('/api/volumes/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})}); if(!r.ok) throw new Error((await r.json()).error); showToast('Volume created'); document.getElementById('new-volume-name').value=''; fetchVolumes(); } catch(e) { showToast(e.message,true); } };

const fetchActivity = async () => { const list=document.getElementById('activity-list'); list.innerHTML='Loading...'; try { const r=await fetch('/api/activity'); const data=await r.json(); list.innerHTML=''; data.forEach(log=>{ const item=document.createElement('div'); item.className='activity-row'; item.innerHTML=`<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-secondary);"><span>${new Date(log.time).toLocaleString()}</span><span style="color:var(--accent-color);font-weight:bold;">${log.user}</span></div><div style="font-size:12px;"><span style="color:var(--green);font-weight:600;">${log.action.toUpperCase()}</span>: ${log.details}</div>`; list.appendChild(item); }); } catch {} };

window.pruneResource = async (type) => { try { const r=await fetch('/api/system/prune',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type})}); const d=await r.json(); if(!r.ok){showToast(d.error,true);return;} showToast(d.message); fetchDashboardStats(); } catch(e) { showToast(e.message,true); } };

// ===== NETWORK PANEL =====
const fetchNetworksPanel = async () => { try { const r=await fetch('/api/networks'); const nets=await r.json(); const c=document.getElementById('networks-table-container'); c.innerHTML=`<table class="network-table"><thead><tr><th>Name</th><th>Driver</th><th>Scope</th><th>Subnet</th><th>Actions</th></tr></thead><tbody>${nets.map(n=>`<tr><td style="color:var(--accent-color);font-weight:600;">${n.Name}</td><td class="net-driver">${n.Driver}</td><td>${n.Scope}</td><td style="font-family:'Fira Code';font-size:11px;">${n.IPAM?.Config?.[0]?.Subnet||'N/A'}</td><td><button class="btn btn-sm bg-red" style="color:white;border-color:var(--red);" onclick="deleteNetwork('${n.Id}')">Delete</button></td></tr>`).join('')}</tbody></table>`; } catch {} };
window.deleteNetwork = async (id) => { try { const r=await fetch(`/api/networks/${id}`,{method:'DELETE'}); const d=await r.json(); if(!r.ok) throw new Error(d.error); showToast(d.message); fetchNetworksPanel(); } catch(e) { showToast(e.message,true); } };
document.getElementById('btn-create-network-panel').onclick = async () => { const name=document.getElementById('new-network-name-panel').value.trim(); const driver=document.getElementById('new-network-driver').value; if(!name){showToast('Enter network name',true);return;} try { const r=await fetch('/api/networks/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,driver})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); showToast(d.message); document.getElementById('new-network-name-panel').value=''; fetchNetworksPanel(); } catch(e) { showToast(e.message,true); } };

// ===== SYSTEM MONITOR =====
const formatBytes = (b) => { if(!b||b===0) return '0 B'; const k=1024; const s=['B','KB','MB','GB']; const i=Math.floor(Math.log(b)/Math.log(k)); return (b/Math.pow(k,i)).toFixed(1)+' '+s[i]; };
const fetchSysMonitor = async () => { try { const r=await fetch('/api/system/disk'); if(!r.ok) return; const d=await r.json(); document.getElementById('sysmonitor-cards').innerHTML=`<div class="stat-card"><div class="stat-icon">🐳</div><div class="stat-value">${d.containers.count}</div><div class="stat-label">Containers</div></div><div class="stat-card"><div class="stat-icon">📀</div><div class="stat-value">${d.images.count}</div><div class="stat-label">Images</div></div><div class="stat-card"><div class="stat-icon">💾</div><div class="stat-value">${d.volumes.count}</div><div class="stat-label">Volumes</div></div><div class="stat-card"><div class="stat-icon">📊</div><div class="stat-value">${formatBytes(d.totalSize)}</div><div class="stat-label">Total Disk</div></div>`; document.getElementById('disk-bars').innerHTML=['Containers','Images','Volumes','Build Cache'].map((label,i)=>{ const vals=[d.containers.size,d.images.size,d.volumes.size,d.buildCache.size]; const pct=d.totalSize?Math.round(vals[i]/d.totalSize*100):0; return `<div class="disk-bar-item"><div class="db-header"><span class="db-label">${label}</span><span class="db-value">${formatBytes(vals[i])} (${pct}%)</span></div><div class="resource-bar"><div class="resource-bar-fill ${pct>80?'warning':''}" style="width:${Math.max(pct,2)}%"></div></div></div>`; }).join(''); } catch {} };

// ===== USERS =====
const fetchUsers = async () => { try { const r=await fetch('/api/users'); if(!r.ok) return; const users=await r.json(); const g=document.getElementById('users-grid'); g.innerHTML=''; users.forEach(u=>{ const c=document.createElement('div'); c.className='image-card'; c.setAttribute('data-user-id',u.id); c.innerHTML=`<h4>${u.username}</h4><div class="image-meta">Role: ${u.role==='admin'?'👑 Admin':'👁 Viewer'}</div><div class="image-card-actions"><button class="btn btn-sm" style="border-color:var(--yellow);color:var(--yellow);" onclick="resetUserPassword('${u.id}','${u.username}')">🔑 Reset</button><button class="btn btn-sm bg-red" style="color:white;border-color:var(--red);" onclick="deleteUser('${u.id}')">Delete</button></div>`; g.appendChild(c); }); } catch {} };
window.resetUserPassword = (id,username) => { const ex=document.getElementById(`reset-form-${id}`); if(ex){ex.remove();return;} const card=document.querySelector(`[data-user-id="${id}"]`); if(!card) return; const f=document.createElement('div'); f.id=`reset-form-${id}`; f.style.cssText='display:flex;gap:8px;margin-top:10px;align-items:center;'; f.innerHTML=`<input type="password" id="reset-pw-${id}" placeholder="New password for ${username}" style="flex-grow:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-dark);color:var(--text-primary);font-size:12px;"><button class="btn btn-sm btn-primary" style="background:var(--accent-gradient);" onclick="submitResetPassword('${id}')">✓</button><button class="btn btn-sm" onclick="document.getElementById('reset-form-${id}').remove()">✗</button>`; card.appendChild(f); document.getElementById(`reset-pw-${id}`).focus(); };
window.submitResetPassword = async (id) => { const input=document.getElementById(`reset-pw-${id}`); const pw=input?input.value.trim():''; if(!pw){showToast('Password cannot be empty',true);return;} try { const r=await fetch(`/api/users/${id}/reset-password`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({newPassword:pw})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); showToast(d.message); const f=document.getElementById(`reset-form-${id}`); if(f)f.remove(); } catch(e){showToast(e.message,true);} };
window.deleteUser = async (id) => { try { const r=await fetch(`/api/users/${id}`,{method:'DELETE'}); const d=await r.json(); if(!r.ok){showToast(d.error,true);return;} showToast(d.message); fetchUsers(); } catch(e){showToast('Delete failed: '+e.message,true);} };
document.getElementById('btn-add-user').onclick = async () => { const u=document.getElementById('new-username').value,p=document.getElementById('new-password').value,role=document.getElementById('new-role').value; await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p,role})}); fetchUsers(); };

// ===== IMAGES =====
const fetchImages = async () => { try { const r=await fetch('/api/images'); const imgs=await r.json(); const g=document.getElementById('images-grid'); g.innerHTML=''; imgs.forEach(img=>{ const tags=img.RepoTags||['<none>:<none>']; const size=(img.Size/1024/1024).toFixed(2); const c=document.createElement('div'); c.className='image-card'; c.innerHTML=`<h4>${tags[0]}</h4><div class="image-meta"><div>Size: ${size} MB</div><div>Created: ${new Date(img.Created*1000).toLocaleDateString()}</div></div><div class="image-card-actions"><button class="btn btn-sm btn-primary" onclick="runImage('${tags[0]}')">Run</button><button class="btn btn-sm" style="border-color:var(--accent-color);" onclick="fetchImageHistory('${img.Id}')">History</button><button class="btn btn-sm bg-red" style="color:white;border-color:var(--red);" onclick="deleteImage('${img.Id}')">Delete</button></div>`; g.appendChild(c); }); } catch(e){console.error(e);} };
window.fetchImageHistory = async (id) => { const list=document.getElementById('history-list'); list.innerHTML='Loading...'; document.getElementById('history-modal').classList.add('show'); try { const r=await fetch(`/api/images/${id}/history`); const data=await r.json(); list.innerHTML=''; data.forEach(l=>{ const row=document.createElement('div'); row.className='activity-row'; row.style.padding='10px'; row.innerHTML=`<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-secondary);"><span>${new Date(l.Created*1000).toLocaleString()}</span><span style="color:var(--accent-color);">${(l.Size/1024/1024).toFixed(2)} MB</span></div><div style="font-family:'Fira Code';font-size:11px;margin-top:5px;word-break:break-all;">${l.CreatedBy}</div>`; list.appendChild(row); }); } catch { list.innerHTML='Error'; } };
document.querySelector('.close-history-btn').onclick = () => document.getElementById('history-modal').classList.remove('show');
window.deleteImage = async (id) => { try { const r=await fetch(`/api/images/${id}/remove`,{method:'POST'}); const d=await r.json(); if(!r.ok) showToast(d.error,true); else { showToast('Image deleted'); fetchImages(); fetchDashboardStats(); } } catch(e){showToast(e.message,true);} };
window.pullImage = async (image) => { showToast(`Pulling ${image}...`); try { const r=await fetch('/api/images/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); showToast(d.message); fetchImages(); } catch(e){showToast(e.message,true);} };

// ===== SELECT CONTAINER =====
const selectContainer = (id, name, state) => {
    if (activeContainerId === id) return;
    activeContainerId = id; renderContainers();
    document.getElementById('top-context-title').textContent = `Container: ${name}`;
    document.getElementById('current-container-name').textContent = name;
    const sb = document.getElementById('current-container-status');
    sb.textContent = state.toUpperCase(); sb.className = `status-badge ${state}`;
    statCpu.textContent='0.00'; statMem.textContent='0.00';
    containerStats.style.display = state==='running' ? 'flex' : 'none';
    welcomeMessage.style.display = 'none'; logHeader.style.display = 'flex';
    logViewer.style.display = 'flex'; logFooter.style.display = 'flex';
    logsContent.innerHTML = '';
    labels.length=0; cpuData.length=0; memData.length=0; cpuChart.update(); memChart.update();
    term.clear();
    document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.view-tab[data-view="logs"]').classList.add('active');
    switchTab('logs');
    // Fetch health
    fetchContainerHealth(id);
    if (socket.connected) socket.disconnect();
    socket.io.opts.query = { containerId: id };
    socket.auth = (cb) => cb({ token: localStorage.getItem('docker_jwt') });
    socket.connect();
    showMainView(logViewerWrapper);
};

const fetchContainerHealth = async (id) => {
    try { const r=await fetch(`/api/containers/${id}/health`); const d=await r.json(); const el=document.getElementById('current-container-health'); if(d.status!=='none'){el.style.display='inline-block';el.textContent=d.status.toUpperCase();el.className=`status-badge ${d.status==='healthy'?'running':d.status==='unhealthy'?'exited':'created'}`;}else{el.style.display='none';} } catch { document.getElementById('current-container-health').style.display='none'; }
};

// ===== LOG STREAM =====
const logFilter = document.getElementById('log-filter');
let isRegexMode = false;
document.getElementById('regex-toggle').onclick = (e) => { isRegexMode = !isRegexMode; e.target.classList.toggle('active', isRegexMode); };

socket.on('log', (chunk) => {
    if (isLogPaused) return;
    const filterText = logFilter?.value || '';
    if (filterText) {
        try {
            if (isRegexMode) { if (!new RegExp(filterText, 'i').test(chunk)) return; }
            else { if (!chunk.toLowerCase().includes(filterText.toLowerCase())) return; }
        } catch { if (!chunk.toLowerCase().includes(filterText.toLowerCase())) return; }
    }
    const div = document.createElement('div');
    const lower = chunk.toLowerCase();
    let cls = 'log-line';
    if (lower.includes('error')||lower.includes('exception')||lower.includes('failed')||lower.includes('fatal')) cls += ' error';
    else if (lower.includes('warn')) cls += ' warn';
    else if (lower.includes('info')||lower.includes('success')) cls += ' info';
    div.className = cls;
    // Highlight search matches
    if (filterText) {
        try {
            const re = isRegexMode ? new RegExp(`(${filterText})`, 'gi') : new RegExp(`(${filterText.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
            div.innerHTML = chunk.replace(/</g,'&lt;').replace(re, '<span class="search-highlight">$1</span>');
        } catch { div.textContent = chunk; }
    } else { div.textContent = chunk; }
    logsContent.appendChild(div);
    if (autoScroll) setTimeout(() => { const last=logsContent.lastElementChild; if(last) last.scrollIntoView({behavior:'auto',block:'end'}); }, 50);
});

socket.on('stats', (data) => {
    statCpu.textContent=data.cpu; statMem.textContent=data.memory;
    if(labels.length>20){labels.shift();cpuData.shift();memData.shift();}
    labels.push(new Date().toLocaleTimeString());
    cpuData.push(parseFloat(data.cpu)); memData.push(parseFloat(data.memory));
    if(document.getElementById('stats-viewer').style.display!=='none'){cpuChart.update();memChart.update();}
});

// ===== CONTROLS =====
document.getElementById('auto-scroll').addEventListener('change',(e)=>{autoScroll=e.target.checked;});
document.getElementById('btn-pause-logs').onclick=(e)=>{isLogPaused=!isLogPaused;e.target.textContent=isLogPaused?'Resume':'Pause';e.target.style.borderColor=isLogPaused?'var(--green)':'var(--yellow)';};
document.getElementById('btn-clear-logs').addEventListener('click',()=>{logsContent.innerHTML='';});
document.getElementById('btn-download-logs').addEventListener('click',()=>{ const t=logsContent.innerText;const b=new Blob([t],{type:'text/plain'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=`logs-${document.getElementById('current-container-name').textContent}.txt`;a.click();URL.revokeObjectURL(u);});

// Log search navigation
document.getElementById('btn-match-prev').onclick = () => { const hl=logsContent.querySelectorAll('.search-highlight'); if(hl.length) hl[0].scrollIntoView({block:'center'}); };
document.getElementById('btn-match-next').onclick = () => { const hl=logsContent.querySelectorAll('.search-highlight'); if(hl.length) hl[hl.length-1].scrollIntoView({block:'center'}); };

// ===== ACTIONS =====
const performAction = async (action) => {
    if (!activeContainerId) return;
    try {
        const r=await fetch(`/api/containers/${activeContainerId}/${action}`,{method:'POST'});
        const d=await r.json(); if(!r.ok) throw new Error(d.error);
        showToast(`Container ${action} success`);
        if(['restart','start','stop'].includes(action)){setTimeout(()=>{if(socket.connected){socket.disconnect();socket.connect();}fetchContainers();},1000);}else{setTimeout(fetchContainers,1500);}
    } catch(e){showToast(`Error: ${e.message}`,true);}
};

const performBulkAction = async (action) => { if(!selectedContainers.size) return; try { await fetch('/api/containers/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,containerIds:Array.from(selectedContainers)})}); setTimeout(fetchContainers,1500); } catch(e){showToast(e.message,true);} };
document.getElementById('btn-bulk-start').onclick=()=>performBulkAction('start');
document.getElementById('btn-bulk-stop').onclick=()=>performBulkAction('stop');
document.getElementById('btn-bulk-remove').onclick=()=>performBulkAction('remove');
document.getElementById('btn-start').onclick=()=>performAction('start');
document.getElementById('btn-stop').onclick=()=>performAction('stop');
document.getElementById('btn-restart').onclick=()=>performAction('restart');
document.getElementById('btn-clone').onclick=()=>performAction('clone');

document.getElementById('btn-rename').onclick=async()=>{const n=prompt('Enter new container name:');if(!n)return;try{const r=await fetch(`/api/containers/${activeContainerId}/rename`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});const d=await r.json();if(!r.ok)throw new Error(d.error);showToast(d.message);document.getElementById('current-container-name').textContent=n;fetchContainers();}catch(e){showToast(e.message,true);}};
document.getElementById('btn-snapshot').onclick=async()=>{const t=prompt('Enter image name (e.g. my-app:v2):');if(!t){showToast('Cancelled',true);return;}try{const r=await fetch(`/api/containers/${activeContainerId}/commit`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag:t})});const d=await r.json();if(!r.ok){showToast(d.error,true);return;}showToast(d.message);fetchDashboardStats();}catch(e){showToast(e.message,true);}};
document.getElementById('update-restart-policy').onchange=async(e)=>{if(!activeContainerId||!e.target.value)return;try{const r=await fetch(`/api/containers/${activeContainerId}/update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({restartPolicy:e.target.value})});const d=await r.json();if(!r.ok)throw new Error(d.error);showToast('Policy updated');}catch(e2){showToast(e2.message,true);}finally{e.target.value='';}};

// ===== EXPORT CONFIG =====
document.getElementById('btn-export').onclick = async () => { if(!activeContainerId)return; try{const r=await fetch(`/api/containers/${activeContainerId}/export-config`);const d=await r.json();const b=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=`container-config-${Date.now()}.json`;a.click();URL.revokeObjectURL(u);showToast('Config exported');}catch(e){showToast(e.message,true);} };

// ===== RESOURCE LIMITS =====
document.getElementById('btn-resources').onclick = () => { if(!activeContainerId) return; document.getElementById('resources-modal').classList.add('show'); };
document.querySelector('.close-resources-btn').onclick = () => document.getElementById('resources-modal').classList.remove('show');
document.getElementById('btn-save-resources').onclick = async () => { try{const r=await fetch(`/api/containers/${activeContainerId}/update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cpuShares:document.getElementById('res-cpu-shares').value,memory:document.getElementById('res-memory').value,memoryReservation:document.getElementById('res-memory-reservation').value})});const d=await r.json();if(!r.ok)throw new Error(d.error);showToast('Resources updated');document.getElementById('resources-modal').classList.remove('show');}catch(e){showToast(e.message,true);} };

// ===== NOTES =====
document.getElementById('btn-notes').onclick = () => { if(!activeContainerId) return; document.getElementById('container-notes').value = getNotes()[activeContainerId]||''; document.getElementById('notes-modal').classList.add('show'); };
document.querySelector('.close-notes-btn').onclick = () => document.getElementById('notes-modal').classList.remove('show');
document.getElementById('btn-save-notes').onclick = () => { saveNote(activeContainerId, document.getElementById('container-notes').value); showToast('Notes saved'); document.getElementById('notes-modal').classList.remove('show'); };

// ===== DELETE =====
document.getElementById('btn-logout').onclick=()=>{localStorage.removeItem('docker_jwt');localStorage.removeItem('docker_role');location.reload();};
const deleteModal=document.getElementById('delete-modal');
document.getElementById('btn-remove').onclick=()=>{if(!activeContainerId)return;deleteModal.classList.add('show');};
document.querySelector('.close-delete-btn').onclick=()=>deleteModal.classList.remove('show');
document.getElementById('btn-cancel-delete').onclick=()=>deleteModal.classList.remove('show');
document.getElementById('btn-confirm-delete').onclick=async()=>{deleteModal.classList.remove('show');try{await performAction('remove');logHeader.style.display='none';logViewer.style.display='none';logFooter.style.display='none';welcomeMessage.style.display='block';activeContainerId=null;fetchDashboardStats();}catch(e){console.error(e);}};

// ===== RUN MODAL =====
const runModal=document.getElementById('run-modal');
const fetchNetworks=async()=>{try{const r=await fetch('/api/networks');const nets=await r.json();const sel=document.getElementById('network-select');sel.innerHTML='<option value="default">Default (bridge)</option>';nets.forEach(n=>{const o=document.createElement('option');o.value=n.Name;o.textContent=`${n.Name} (${n.Driver})`;sel.appendChild(o);});}catch{}};
document.getElementById('btn-create-network').onclick=async()=>{const name=document.getElementById('new-network-name').value.trim();if(!name){showToast('Enter network name',true);return;}try{const r=await fetch('/api/networks/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,driver:'bridge'})});const d=await r.json();if(!r.ok){showToast(d.error,true);return;}showToast(d.message);document.getElementById('new-network-name').value='';fetchNetworks();}catch(e){showToast(e.message,true);}};

const openRunModal = (tag='') => { document.getElementById('image-name').value = tag==='<none>:<none>'?'':tag; fetchNetworks(); runModal.classList.add('show'); };
window.runImage = openRunModal;

const bindBtn=(id,fn)=>{const el=document.getElementById(id);if(el)el.onclick=fn;};
bindBtn('btn-run-cmd-sidebar',()=>openRunModal());
bindBtn('btn-compose-sidebar',()=>document.getElementById('compose-modal').classList.add('show'));
bindBtn('btn-run-cmd-images',()=>openRunModal());
bindBtn('btn-show-build-modal',()=>{document.getElementById('build-modal').classList.add('show');document.getElementById('build-log-content').innerHTML='Waiting for build...';});
const closeBtn=document.querySelector('.close-btn');if(closeBtn)closeBtn.onclick=()=>runModal.classList.remove('show');
bindBtn('btn-cancel-run',()=>runModal.classList.remove('show'));

document.getElementById('btn-submit-run').onclick=async()=>{const image=document.getElementById('image-name').value;const cName=document.getElementById('new-container-name').value;const vName=document.getElementById('volume-name').value;const ports=document.getElementById('port-mappings').value.split(',').map(p=>p.trim()).filter(p=>p);const envs=document.getElementById('env-vars').value.split(',').map(e=>e.trim()).filter(e=>e);const rp=document.getElementById('restart-policy').value;const net=document.getElementById('network-select').value;const cpus=document.getElementById('run-cpus').value.trim()||undefined;const memory=document.getElementById('run-memory').value.trim()||undefined;const cpuShares=document.getElementById('run-cpu-shares').value.trim()||undefined;const memReservation=document.getElementById('run-mem-reservation').value.trim()||undefined;const hostname=document.getElementById('run-hostname').value.trim()||undefined;const command=document.getElementById('run-command').value.trim()||undefined;const privileged=document.getElementById('run-privileged').checked;const autoRemove=document.getElementById('run-auto-remove').checked;const tty=document.getElementById('run-tty').checked;const sd=document.getElementById('run-status');const btn=document.getElementById('btn-submit-run');if(!image){sd.className='status-msg error';sd.textContent='Image required';return;}btn.disabled=true;btn.textContent='Pulling & Running...';sd.textContent='';try{const r=await fetch('/api/containers/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,containerName:cName,volumeName:vName,ports,envs,restartPolicy:rp,network:net,cpus,memory,cpuShares,memReservation,hostname,command,privileged,autoRemove,tty})});const d=await r.json();if(!r.ok)throw new Error(d.error);sd.className='status-msg success';sd.textContent=`Success!${cpus?' CPU: '+cpus:''}${memory?' MEM: '+memory:''}`;setTimeout(()=>{runModal.classList.remove('show');fetchContainers();fetchDashboardStats();},1500);}catch(e){sd.className='status-msg error';sd.textContent=`Error: ${e.message}`;}finally{btn.disabled=false;btn.textContent='Run Container';}};

// ===== BUILD =====
document.querySelector('.close-build-btn').onclick=()=>document.getElementById('build-modal').classList.remove('show');
document.getElementById('btn-start-build').onclick=async()=>{const tag=document.getElementById('build-tag').value.trim();const df=document.getElementById('build-dockerfile').value;if(!tag)return showToast('Provide image tag',true);const lc=document.getElementById('build-log-content');lc.innerHTML='<div style="color:#0ff">Starting build for '+tag+'...</div>';try{const r=await fetch('/api/images/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag,dockerfile:df})});const text=await r.text();let d;try{d=JSON.parse(text);}catch(e){throw new Error('Non-JSON response');}if(!r.ok)throw new Error(d.error||'Build failed');showToast('Build initiated');}catch(e){lc.innerHTML+='<div style="color:#f00">Error: '+e.message+'</div>';showToast(e.message,true);}};
socket.on('build-progress',(data)=>{const c=document.getElementById('build-log-container');const ct=document.getElementById('build-log-content');if(data.event.stream)ct.innerHTML+='<div>'+data.event.stream+'</div>';else if(data.event.status)ct.innerHTML+='<div style="color:var(--accent-color)">'+data.event.status+'</div>';c.scrollTop=c.scrollHeight;});
socket.on('build-status',(data)=>{const ct=document.getElementById('build-log-content');if(data.status==='success'){ct.innerHTML+='<div style="color:#0f0;font-weight:bold;margin-top:10px;">Build Successful! '+data.tag+'</div>';showToast('Build completed: '+data.tag);fetchImages();if(document.getElementById('build-run-after').checked)setTimeout(()=>{document.getElementById('build-modal').classList.remove('show');openRunModal(data.tag);},1000);}else{ct.innerHTML+='<div style="color:#f00;font-weight:bold;">Build Failed: '+data.error+'</div>';showToast('Build failed',true);}});

// ===== HUB SEARCH =====
document.getElementById('btn-hub-search').onclick=async()=>{const t=document.getElementById('hub-search').value.trim();if(!t)return;const r=await fetch(`/api/images/search?term=${encodeURIComponent(t)}`);const data=await r.json();const res=document.getElementById('hub-results');res.innerHTML='<h4>Docker Hub Results</h4>';data.forEach(img=>{const row=document.createElement('div');row.className='activity-row';row.style.padding='12px';row.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;"><span style="font-weight:600;color:var(--accent-color);">${img.name}</span><div style="display:flex;align-items:center;gap:10px;"><span style="font-size:11px;">${img.star_count} ⭐</span><button class="btn btn-sm btn-primary" onclick="pullImage('${img.name}')">Pull</button></div></div><div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">${img.description||'No description'}</div>`;res.appendChild(row);});};

// ===== PASSWORD =====
bindBtn('btn-show-password-modal',()=>document.getElementById('password-modal').classList.add('show'));
const cpBtn=document.querySelector('.close-password-btn');if(cpBtn)cpBtn.onclick=()=>document.getElementById('password-modal').classList.remove('show');
bindBtn('btn-submit-password',async()=>{const op=document.getElementById('change-old-password').value;const np=document.getElementById('change-new-password').value;if(!op||!np)return showToast('Fill all fields',true);try{const r=await fetch('/api/users/change-password',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('docker_jwt')},body:JSON.stringify({oldPassword:op,newPassword:np})});const d=await r.json();if(!r.ok)throw new Error(d.error);showToast('Password changed');document.getElementById('password-modal').classList.remove('show');document.getElementById('change-old-password').value='';document.getElementById('change-new-password').value='';}catch(e){showToast(e.message,true);}});

// ===== COMPOSE DEPLOY =====
document.querySelector('.close-compose-btn').onclick=()=>document.getElementById('compose-modal').classList.remove('show');
document.getElementById('btn-compose-deploy').onclick=async()=>{const yaml=document.getElementById('compose-yaml').value;const proj=document.getElementById('compose-project').value.trim()||'dockpilot';const res_el=document.getElementById('compose-results');res_el.innerHTML='<div style="padding:10px;color:var(--text-secondary);">Deploying stack...</div>';try{const r=await fetch('/api/compose/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({yamlContent:yaml,projectName:proj})});const d=await r.json();if(!r.ok)throw new Error(d.error);res_el.innerHTML='<h4>Deploy Results</h4>'+d.results.map(s=>`<div class="compose-result-item"><span class="cr-status ${s.status}">${s.status}</span><span>${s.service}</span>${s.error?`<span style="color:var(--red);font-size:11px;">${s.error}</span>`:''}</div>`).join('');showToast(d.message);fetchContainers();}catch(e){res_el.innerHTML=`<div style="color:var(--red);">Error: ${e.message}</div>`;showToast(e.message,true);}};

// ===== IMPORT CONFIG =====
document.querySelector('.close-import-btn').onclick=()=>document.getElementById('import-modal').classList.remove('show');
document.getElementById('btn-import-config').onclick=async()=>{const json=document.getElementById('import-json').value;const name=document.getElementById('import-name').value.trim();const sd=document.getElementById('import-status');try{const config=JSON.parse(json);if(name)config.name=name;const r=await fetch('/api/containers/import-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});const d=await r.json();if(!r.ok)throw new Error(d.error);sd.className='status-msg success';sd.textContent='Container created!';showToast(d.message);fetchContainers();setTimeout(()=>document.getElementById('import-modal').classList.remove('show'),1500);}catch(e){sd.className='status-msg error';sd.textContent=`Error: ${e.message}`;}};

// ===== COMMAND PALETTE =====
const cpOverlay=document.getElementById('command-palette-overlay');
const cpInput=document.getElementById('command-palette-input');
const cpResults=document.getElementById('command-palette-results');
let cpIndex=0;

const commands=[
    {icon:'🐳',text:'Show Dashboard',action:()=>showMainView(logViewerWrapper)},
    {icon:'📀',text:'Open Images',action:()=>{showMainView(imagesView);fetchImages();}},
    {icon:'💾',text:'Open Volumes',action:()=>{showMainView(volumesView);fetchVolumes();}},
    {icon:'🌐',text:'Open Networks',action:()=>{showMainView(networksView);fetchNetworksPanel();}},
    {icon:'📊',text:'System Monitor',action:()=>{showMainView(sysmonitorView);fetchSysMonitor();}},
    {icon:'👥',text:'User Management',action:()=>{showMainView(usersView);fetchUsers();}},
    {icon:'📋',text:'Activity Log',action:()=>{showMainView(activityView);fetchActivity();}},
    {icon:'🔧',text:'System Maintenance',action:()=>showMainView(maintenanceView)},
    {icon:'➕',text:'Run New Container',action:()=>openRunModal()},
    {icon:'🏗️',text:'Build Image',action:()=>{document.getElementById('build-modal').classList.add('show');}},
    {icon:'📦',text:'Deploy Compose Stack',action:()=>document.getElementById('compose-modal').classList.add('show')},
    {icon:'📋',text:'Import Container Config',action:()=>document.getElementById('import-modal').classList.add('show')},
    {icon:'🔑',text:'Change Password',action:()=>document.getElementById('password-modal').classList.add('show')},
    {icon:'🎨',text:'Theme: Cyberpunk',action:()=>setTheme('cyberpunk')},
    {icon:'🌙',text:'Theme: Midnight Blue',action:()=>setTheme('midnight')},
    {icon:'🌿',text:'Theme: Emerald Dark',action:()=>setTheme('emerald')},
    {icon:'🌅',text:'Theme: Sunset Warm',action:()=>setTheme('sunset')},
    {icon:'🌌',text:'Theme: Aurora Borealis',action:()=>setTheme('aurora')},
    {icon:'🌸',text:'Theme: Rose Gold',action:()=>setTheme('rosegold')},
    {icon:'🌊',text:'Theme: Ocean Deep',action:()=>setTheme('ocean')},
    {icon:'🧛',text:'Theme: Dracula',action:()=>setTheme('dracula')},
    {icon:'🗑️',text:'Prune Containers',action:()=>pruneResource('containers')},
    {icon:'🗑️',text:'Prune Images',action:()=>pruneResource('images')},
    {icon:'🗑️',text:'Prune Volumes',action:()=>pruneResource('volumes')},
    {icon:'🚪',text:'Logout',action:()=>{localStorage.clear();location.reload();}},
];

const renderCP = (filter='') => {
    const f=filter.toLowerCase();
    const filtered=commands.filter(c=>c.text.toLowerCase().includes(f));
    // Add container commands
    containersData.forEach(c=>{const name=c.Names[0].replace('/','');if(name.toLowerCase().includes(f)||'container'.includes(f)){filtered.push({icon:'🐳',text:`Select: ${name}`,action:()=>selectContainer(c.Id,name,c.State)});}});
    cpIndex=Math.min(cpIndex,filtered.length-1);
    cpResults.innerHTML=filtered.slice(0,15).map((c,i)=>`<div class="command-palette-item ${i===cpIndex?'active':''}" data-idx="${i}"><span class="cp-icon">${c.icon}</span><span class="cp-text">${c.text}</span></div>`).join('');
    cpResults.querySelectorAll('.command-palette-item').forEach(el=>{el.onclick=()=>{cpOverlay.classList.remove('show');filtered[parseInt(el.dataset.idx)]?.action();};});
};

const openCP=()=>{cpOverlay.classList.add('show');cpInput.value='';cpIndex=0;renderCP();setTimeout(()=>cpInput.focus(),50);};
const closeCP=()=>cpOverlay.classList.remove('show');

cpInput.oninput=()=>{cpIndex=0;renderCP(cpInput.value);};
cpInput.onkeydown=(e)=>{
    const items=cpResults.querySelectorAll('.command-palette-item');
    if(e.key==='ArrowDown'){e.preventDefault();cpIndex=Math.min(cpIndex+1,items.length-1);renderCP(cpInput.value);}
    else if(e.key==='ArrowUp'){e.preventDefault();cpIndex=Math.max(cpIndex-1,0);renderCP(cpInput.value);}
    else if(e.key==='Enter'){e.preventDefault();const active=items[cpIndex];if(active)active.click();}
    else if(e.key==='Escape'){closeCP();}
};
cpOverlay.onclick=(e)=>{if(e.target===cpOverlay)closeCP();};

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
    if(e.ctrlKey && e.key==='k'){e.preventDefault();openCP();}
    if(e.key==='Escape'){closeCP();document.querySelectorAll('.modal.show').forEach(m=>m.classList.remove('show'));}
    if(e.ctrlKey && e.key==='n'){e.preventDefault();openRunModal();}
    if(e.ctrlKey && e.key==='r'&&!e.shiftKey){e.preventDefault();fetchContainers();fetchDashboardStats();showToast('Refreshed');}
});

// Hide shortcut hint after 8s
setTimeout(()=>{const h=document.getElementById('shortcut-hint');if(h)h.style.display='none';},8000);

// ===== ENTER KEY SETUP =====
const setupEnterKey=(inputId,btnId)=>{const el=document.getElementById(inputId);if(el)el.onkeyup=(e)=>{if(e.key==='Enter')document.getElementById(btnId).click();};};
setupEnterKey('login-password','btn-login');
setupEnterKey('change-new-password','btn-submit-password');
setupEnterKey('hub-search','btn-hub-search');

// ===== INIT =====
if (localStorage.getItem('docker_jwt')) {
    document.getElementById('login-overlay').style.display = 'none';
    applyRoleConstraints(); initSession(); fetchContainers(); fetchDashboardStats();
}
setInterval(fetchContainers, 5000);
setInterval(fetchDashboardStats, 10000);
