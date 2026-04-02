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
    const res = await originalFetch(resource, config);
    if (res.status === 401 && resource !== '/api/login') {
        document.getElementById('login-overlay').style.display = 'flex';
    }
    return res;
};

document.getElementById('btn-login').onclick = async () => {
    const username = document.getElementById('login-username').value || 'admin';
    const password = document.getElementById('login-password').value;
    const res = await originalFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    if (res.ok) {
        const data = await res.json();
        localStorage.setItem('docker_jwt', data.token);
        localStorage.setItem('docker_role', data.role);
        document.getElementById('login-overlay').style.display = 'none';
        socket.auth = { token: data.token };
        applyRoleConstraints();
        fetchContainers();
        fetchGlobalStats();
    } else {
        const errorDiv = document.getElementById('login-error');
        errorDiv.textContent = 'Invalid username or password';
        errorDiv.style.display = 'block';
    }
};

const socket = io({ autoConnect: false, auth: { token: localStorage.getItem('docker_jwt') } });
let activeContainerId = null;

const applyRoleConstraints = () => {
    const role = localStorage.getItem('docker_role');
    const adminEls = document.querySelectorAll('.admin-only');
    if (role !== 'admin') {
        adminEls.forEach(el => el.style.setProperty('display', 'none', 'important'));
    } else {
        adminEls.forEach(el => el.style.removeProperty('display'));
    }
};

const fetchGlobalStats = async () => {
    try {
        const res = await fetch('/api/system/info');
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('host-os').textContent = data.operatingSystem;
        document.getElementById('total-containers').textContent = data.containersTotal;
        document.getElementById('total-images').textContent = data.imagesTotal;
        document.getElementById('total-mem').textContent = data.memTotal;
        document.getElementById('total-cpu').textContent = data.ncpu;
    } catch { };
};

// Only start polling stats if already authenticated
if (localStorage.getItem('docker_jwt')) {
    fetchGlobalStats();
    setInterval(fetchGlobalStats, 10000);
}

if (localStorage.getItem('docker_jwt')) {
    document.getElementById('login-overlay').style.display = 'none';
    applyRoleConstraints();
}
let containersData = [];
let autoScroll = true;

// Toast notification helper (replaces confirm/alert which browsers block)
let toastOffset = 20;
const showToast = (msg, isError = false) => {
    const toast = document.createElement('div');
    toast.textContent = msg;
    const top = toastOffset;
    toastOffset += 50;
    toast.style.cssText = `position:fixed;top:${top}px;right:20px;padding:12px 20px;border-radius:6px;z-index:99999;color:white;font-size:13px;transition:opacity 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.3);background:${isError ? '#ff0055' : '#39ff14'};`;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toastOffset -= 50; setTimeout(() => toast.remove(), 300); }, 3000);
};

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

// Bulk Selection State
let selectedContainers = new Set();
const bulkActions = document.getElementById('bulk-actions');
const bulkCount = document.getElementById('bulk-count');
const selectAllCheckbox = document.getElementById('select-all-containers');

const updateBulkUI = () => {
    bulkCount.textContent = selectedContainers.size;
    bulkActions.style.display = selectedContainers.size > 0 ? 'flex' : 'none';
    selectAllCheckbox.checked = containersData.length > 0 && selectedContainers.size === containersData.length;
};

// Chart Setup
let cpuChart, memChart;
let cpuData = [], memData = [], labels = [];

const initCharts = () => {
    const cpuCtx = document.getElementById('cpuChart').getContext('2d');
    const memCtx = document.getElementById('memChart').getContext('2d');

    cpuChart = new Chart(cpuCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'CPU Usage %', data: cpuData, borderColor: '#58a6ff', tension: 0.4 }] },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });

    memChart = new Chart(memCtx, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Memory Usage (MB)', data: memData, borderColor: '#da3633', tension: 0.4 }] },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } }
    });
};
initCharts();

// Terminal Setup
const term = new Terminal({
    theme: { background: '#000', foreground: '#eff0eb' },
    fontFamily: '"Fira Code", monospace',
    fontSize: 14,
    cursorBlink: true
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-viewer'));

term.onData(data => socket.emit('exec-input', data));
socket.on('exec-output', data => term.write(data));

window.addEventListener('resize', () => {
    if (document.getElementById('terminal-viewer').style.display !== 'none') {
        fitAddon.fit();
        socket.emit('exec-resize', { cols: term.cols, rows: term.rows });
    }
});

// View Tabs Selector
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
    btn.onclick = (e) => {
        const cmd = e.target.dataset.cmd;
        socket.emit('exec-input', cmd + '\n');
    };
});

function switchTab(viewName) {
    Object.values(views).forEach(v => v.style.display = 'none');
    views[viewName].style.display = (viewName === 'stats' || viewName === 'logs' || viewName === 'env') ? 'flex' : 'block';

    if (viewName === 'terminal') {
        setTimeout(() => {
            fitAddon.fit();
            socket.emit('exec-start', { Cmd: ['/bin/sh'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true });
            setTimeout(() => socket.emit('exec-resize', { cols: term.cols, rows: term.rows }), 200);
        }, 100);
    }

    // Only show log footer if we are in the logs view
    logFooter.style.display = (viewName === 'logs') ? 'flex' : 'none';

    if (viewName === 'env' && activeContainerId) fetchEnvVars();
    if (viewName === 'files' && activeContainerId) fetchFiles('/');
    if (viewName === 'diff' && activeContainerId) fetchDiff();
    if (viewName === 'raw' && activeContainerId) fetchRawInspect();
}

const fetchRawInspect = async () => {
    const el = document.getElementById('raw-inspect-content');
    el.textContent = 'Loading...';
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/inspect`);
        const data = await res.json();
        el.textContent = JSON.stringify(data, null, 2);
    } catch { el.textContent = 'Error loading inspect data'; }
};

let currentPath = '/';
const fetchFiles = async (path) => {
    currentPath = path;
    document.getElementById('files-path').textContent = path;
    const list = document.getElementById('files-list');
    list.innerHTML = 'Loading...';
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/files?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        list.innerHTML = '';
        data.files.forEach(f => {
            const row = document.createElement('div');
            row.className = 'file-row';
            row.innerHTML = `
                <span style="cursor:${f.isDir ? 'pointer' : 'default'}; color:${f.isDir ? 'var(--accent-color)' : 'var(--text-primary)'}">
                    ${f.isDir ? '📁' : '📄'} ${f.name}
                </span>
                <span style="color:var(--text-secondary); font-size: 11px;">${f.size} | ${f.perms}</span>
            `;
            if (f.isDir) {
                row.onclick = () => {
                    const newPath = currentPath === '/' ? `/${f.name}` : `${currentPath}/${f.name}`;
                    fetchFiles(newPath);
                };
            }
            list.appendChild(row);
        });
    } catch { list.innerHTML = 'Error loading files'; }
};

document.getElementById('btn-files-up').onclick = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(p => p);
    parts.pop();
    fetchFiles('/' + parts.join('/'));
};

const fetchDiff = async () => {
    const list = document.getElementById('diff-list');
    list.innerHTML = 'Loading...';
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/diff`);
        const data = await res.json();
        list.innerHTML = '';
        if (data.length === 0) list.innerHTML = '<div style="color:var(--text-secondary)">No changes detected</div>';
        data.forEach(change => {
            const row = document.createElement('div');
            const typeDisplay = ['MOD', 'ADD', 'DEL'][change.Kind] || '???';
            const color = ['var(--yellow)', 'var(--green)', 'var(--red)'][change.Kind] || 'white';
            row.innerHTML = `<span style="color:${color}; width:40px; display:inline-block">${typeDisplay}</span> ${change.Path}`;
            list.appendChild(row);
        });
    } catch { list.innerHTML = 'Error loading diff'; }
};

const fetchEnvVars = async () => {
    const list = document.getElementById('env-list');
    list.innerHTML = 'Loading...';
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/inspect`);
        const data = await res.json();
        list.innerHTML = '';
        (data.Config.Env || []).forEach(env => {
            const [key, ...val] = env.split('=');
            const row = document.createElement('div');
            row.style.background = 'var(--bg-dark)';
            row.style.padding = '8px 12px';
            row.style.borderRadius = '4px';
            row.style.border = '1px solid var(--border-color)';
            row.style.fontSize = '12px';
            row.innerHTML = `<span style="color: var(--accent-color); font-weight: 600;">${key}</span> = <span style="color: var(--text-primary);">${val.join('=')}</span>`;
            list.appendChild(row);
        });
    } catch { };
};


document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        switchTab(e.target.dataset.view);
    });
});


const usersView = document.getElementById('users-view');
const maintenanceView = document.getElementById('maintenance-view');
const activityView = document.getElementById('activity-view');
const volumesView = document.getElementById('volumes-view');

const showMainView = (viewEl) => {
    // Hide all main panels and the log viewer wrapper
    [imagesView, usersView, maintenanceView, activityView, volumesView, logViewerWrapper].forEach(el => el.style.display = 'none');

    // Reset Welcome Message
    welcomeMessage.style.display = 'none';

    const topTitle = document.getElementById('top-context-title');

    if (viewEl === logViewerWrapper) {
        viewEl.style.display = 'flex';
        if (!activeContainerId) {
            welcomeMessage.style.display = 'block';
            document.getElementById('log-header').style.display = 'none';
            topTitle.textContent = 'Dashboard Overview';
        } else {
            document.getElementById('log-header').style.display = 'flex';
            // Title is set in selectContainer
        }
    } else {
        viewEl.style.display = 'flex';
        document.getElementById('log-header').style.display = 'none';

        // Update title based on view element
        if (viewEl === imagesView) topTitle.textContent = 'Docker Images';
        if (viewEl === usersView) topTitle.textContent = 'User Management';
        if (viewEl === activityView) topTitle.textContent = 'Activity Audit Log';
        if (viewEl === maintenanceView) topTitle.textContent = 'System Maintenance';
        if (viewEl === volumesView) topTitle.textContent = 'Volume Management';
    }
};

document.getElementById('nav-images').onclick = () => { showMainView(imagesView); fetchImages(); };
document.getElementById('btn-close-images').onclick = () => { showMainView(logViewerWrapper); };

document.getElementById('nav-users').onclick = () => { showMainView(usersView); fetchUsers(); };
document.getElementById('btn-close-users').onclick = () => { showMainView(logViewerWrapper); };

document.getElementById('nav-maintenance').onclick = () => { showMainView(maintenanceView); };
document.getElementById('btn-close-maintenance').onclick = () => { showMainView(logViewerWrapper); };

document.getElementById('nav-activity').onclick = () => { showMainView(activityView); fetchActivity(); };
document.getElementById('btn-close-activity').onclick = () => { showMainView(logViewerWrapper); };

document.getElementById('nav-volumes').onclick = () => { showMainView(volumesView); fetchVolumes(); };
document.getElementById('btn-close-volumes').onclick = () => { showMainView(logViewerWrapper); };

const fetchVolumes = async () => {
    try {
        const res = await fetch('/api/volumes');
        const volumes = await res.json();
        const grid = document.getElementById('volumes-grid');
        grid.innerHTML = '';
        volumes.forEach(v => {
            const card = document.createElement('div');
            card.className = 'image-card';
            card.innerHTML = `
                <h4>${v.Name.substring(0, 24)}${v.Name.length > 24 ? '...' : ''}</h4>
                <div class="image-meta">
                    <div>Driver: ${v.Driver}</div>
                    <div style="font-size:10px; color:var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${v.Mountpoint}">${v.Mountpoint}</div>
                </div>
                <div class="image-card-actions">
                    <button class="btn btn-sm bg-red" style="color:white;border-color:var(--red);" onclick="deleteVolume('${v.Name}')">Delete</button>
                </div>
            `;
            grid.appendChild(card);
        });
    } catch { }
};

window.deleteVolume = async (name) => {
    try {
        const res = await fetch(`/api/volumes/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(data.message);
        fetchVolumes();
    } catch (err) { showToast(err.message, true); }
};

document.getElementById('btn-create-volume').onclick = async () => {
    const name = document.getElementById('new-volume-name').value.trim();
    if (!name) return;
    try {
        const res = await fetch('/api/volumes/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast('Volume created');
        document.getElementById('new-volume-name').value = '';
        fetchVolumes();
    } catch (err) { showToast(err.message, true); }
};

const fetchActivity = async () => {
    const list = document.getElementById('activity-list');
    list.innerHTML = 'Loading...';
    try {
        const res = await fetch('/api/activity');
        const data = await res.json();
        list.innerHTML = '';
        data.forEach(log => {
            const item = document.createElement('div');
            item.className = 'activity-row';
            item.innerHTML = `
                <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-secondary);">
                    <span>${new Date(log.time).toLocaleString()}</span>
                    <span style="color:var(--accent-color); font-weight:bold;">${log.user}</span>
                </div>
                <div style="font-size:12px;"><span style="color:var(--green); font-weight:600;">${log.action.toUpperCase()}</span>: ${log.details}</div>
            `;
            list.appendChild(item);
        });
    } catch { }
};

window.pruneResource = async (type) => {
    try {
        const res = await fetch('/api/system/prune', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error, true); return; }
        showToast(data.message);
        fetchGlobalStats();
    } catch (err) { showToast(err.message, true); }
};

const fetchUsers = async () => {
    try {
        const res = await fetch('/api/users');
        if (!res.ok) return;
        const users = await res.json();
        const grid = document.getElementById('users-grid');
        grid.innerHTML = '';
        users.forEach(u => {
            const card = document.createElement('div');
            card.className = 'image-card';
            card.setAttribute('data-user-id', u.id);
            card.innerHTML = `
                <h4>${u.username}</h4>
                <div class="image-meta">Role: ${u.role === 'admin' ? '👑 Admin' : '👁 Viewer'}</div>
                <div class="image-card-actions">
                    <button class="btn btn-sm" style="border-color:var(--yellow);color:var(--yellow);" onclick="resetUserPassword('${u.id}', '${u.username}')">🔑 Reset Password</button>
                    <button class="btn btn-sm bg-red" style="color:white;border-color:var(--red);" onclick="deleteUser('${u.id}')">Delete</button>
                </div>
            `;
            grid.appendChild(card);
        });
    } catch (err) { }
};

window.resetUserPassword = (id, username) => {
    // Show inline input instead of prompt (which browsers block)
    const existing = document.getElementById(`reset-form-${id}`);
    if (existing) { existing.remove(); return; }

    const card = document.querySelector(`[data-user-id="${id}"]`);
    if (!card) return;

    const form = document.createElement('div');
    form.id = `reset-form-${id}`;
    form.style.cssText = 'display:flex;gap:8px;margin-top:10px;align-items:center;';
    form.innerHTML = `
        <input type="password" id="reset-pw-${id}" placeholder="New password for ${username}" style="flex-grow:1;padding:6px 10px;border-radius:6px;border:1px solid var(--border-color);background:var(--bg-dark);color:var(--text-primary);font-size:12px;">
        <button class="btn btn-sm btn-primary" style="background:var(--accent-gradient);" onclick="submitResetPassword('${id}')">✓</button>
        <button class="btn btn-sm" onclick="document.getElementById('reset-form-${id}').remove()">✗</button>
    `;
    card.appendChild(form);
    document.getElementById(`reset-pw-${id}`).focus();
};

window.submitResetPassword = async (id) => {
    const input = document.getElementById(`reset-pw-${id}`);
    const newPassword = input ? input.value.trim() : '';
    if (!newPassword) { showToast('Password cannot be empty', true); return; }
    try {
        const res = await fetch(`/api/users/${id}/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(data.message);
        const form = document.getElementById(`reset-form-${id}`);
        if (form) form.remove();
    } catch (err) { showToast(err.message, true); }
};

window.deleteUser = async (id) => {
    try {
        const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) { showToast(data.error, true); return; }
        showToast(data.message);
        fetchUsers();
    } catch (err) { showToast('Delete failed: ' + err.message, true); }
};

document.getElementById('btn-add-user').onclick = async () => {
    const u = document.getElementById('new-username').value;
    const p = document.getElementById('new-password').value;
    const r = document.getElementById('new-role').value;
    await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p, role: r }) });
    fetchUsers();
};

const fetchImages = async () => {
    try {
        const res = await fetch('/api/images');
        const images = await res.json();
        const grid = document.getElementById('images-grid');
        grid.innerHTML = '';
        images.forEach(img => {
            const tags = img.RepoTags || ['<none>:<none>'];
            const sizeMB = (img.Size / 1024 / 1024).toFixed(2);
            const card = document.createElement('div');
            card.className = 'image-card';
            card.innerHTML = `
                <h4>${tags[0]}</h4>
                <div class="image-meta">
                    <div>Size: ${sizeMB} MB</div>
                    <div>Created: ${new Date(img.Created * 1000).toLocaleDateString()}</div>
                </div>
                <div class="image-card-actions">
                    <button class="btn btn-sm btn-primary" onclick="runImage('${tags[0]}')">Run</button>
                    <button class="btn btn-sm" style="border-color:var(--accent-color);" onclick="fetchImageHistory('${img.Id}')">History</button>
                    <button class="btn btn-sm bg-red" style="color:white;border-color:var(--red);" onclick="deleteImage('${img.Id}')">Delete</button>
                </div>
            `;
            grid.appendChild(card);
        });
    } catch (err) {
        console.error(err);
    }
};

window.fetchImageHistory = async (id) => {
    const list = document.getElementById('history-list');
    list.innerHTML = 'Loading layers...';
    document.getElementById('history-modal').classList.add('show');
    try {
        const res = await fetch(`/api/images/${id}/history`);
        const data = await res.json();
        list.innerHTML = '';
        data.forEach(layer => {
            const row = document.createElement('div');
            row.className = 'activity-row';
            row.style.padding = '10px';
            const sizeMB = (layer.Size / 1024 / 1024).toFixed(2);
            row.innerHTML = `
                <div style="display:flex; justify-content:space-between; font-size:10px; color:var(--text-secondary);">
                    <span>${new Date(layer.Created * 1000).toLocaleString()}</span>
                    <span style="color:var(--accent-color);">${sizeMB} MB</span>
                </div>
                <div style="font-family:'Fira Code'; font-size:11px; margin-top:5px; word-break:break-all;">${layer.CreatedBy}</div>
            `;
            list.appendChild(row);
        });
    } catch { list.innerHTML = 'Error loading history'; }
};

document.querySelector('.close-history-btn').onclick = () => {
    document.getElementById('history-modal').classList.remove('show');
};

// Build Image Modal
document.querySelector('.close-build-btn').onclick = () => {
    document.getElementById('build-modal').classList.remove('show');
};

document.getElementById('btn-start-build').onclick = async () => {
    const tag = document.getElementById('build-tag').value.trim();
    const dockerfile = document.getElementById('build-dockerfile').value;
    if (!tag) return showToast('Please provide an image tag', true);

    const logContent = document.getElementById('build-log-content');
    logContent.innerHTML = '<div style="color:#0ff">Starting build for ' + tag + '...</div>';

    try {
        const res = await fetch('/api/images/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag, dockerfile })
        });
        const text = await res.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error('Server returned non-JSON response: ' + text.substring(0, 100));
        }

        if (!res.ok) throw new Error(data.error || 'Build failed to start');
        showToast('Build process initiated');
    } catch (err) {
        logContent.innerHTML += '<div style="color:#f00">Error: ' + err.message + '</div>';
        showToast(err.message, true);
    }
};

// Socket events for Build
socket.on('build-progress', (data) => {
    const container = document.getElementById('build-log-container');
    const content = document.getElementById('build-log-content');
    if (data.event.stream) {
        content.innerHTML += '<div>' + data.event.stream + '</div>';
    } else if (data.event.status) {
        content.innerHTML += '<div style="color:var(--accent-color)">' + data.event.status + '</div>';
    }
    container.scrollTop = container.scrollHeight;
});

socket.on('build-status', (data) => {
    const content = document.getElementById('build-log-content');
    if (data.status === 'success') {
        content.innerHTML += '<div style="color:#0f0; font-weight:bold; margin-top:10px;">Build Successful! Image tagged as ' + data.tag + '</div>';
        showToast('Build completed: ' + data.tag);
        fetchImages();

        // Auto-run if requested
        if (document.getElementById('build-run-after').checked) {
            setTimeout(() => {
                document.getElementById('build-modal').classList.remove('show');
                openRunModal(data.tag);
            }, 1000);
        }
    } else {
        content.innerHTML += '<div style="color:#f00; font-weight:bold; margin-top:10px;">Build Failed: ' + data.error + '</div>';
        showToast('Build failed', true);
    }
});

document.getElementById('btn-hub-search').onclick = async () => {
    const term = document.getElementById('hub-search').value.trim();
    if (!term) return;
    const res = await fetch(`/api/images/search?term=${encodeURIComponent(term)}`);
    const data = await res.json();
    const results = document.getElementById('hub-results');
    results.innerHTML = '<h4>Docker Hub Results</h4>';
    data.forEach(img => {
        const row = document.createElement('div');
        row.className = 'activity-row';
        row.style.padding = '12px';
        row.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-weight:600; color:var(--accent-color);">${img.name}</span>
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-size:11px;">${img.star_count} ⭐</span>
                    <button class="btn btn-sm btn-primary" onclick="pullImage('${img.name}')">Pull</button>
                </div>
            </div>
            <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${img.description || 'No description available'}</div>
        `;
        results.appendChild(row);
    });
};

window.pullImage = async (image) => {
    showToast(`Pulling ${image}...`);
    try {
        const res = await fetch('/api/images/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(data.message);
        fetchImages();
    } catch (err) { showToast(err.message, true); }
};

const openRunModal = (tag = '') => {
    document.getElementById('image-name').value = tag === '<none>:<none>' ? '' : tag;
    fetchNetworks();
    document.getElementById('run-modal').classList.add('show');
};

window.runImage = openRunModal;
// Run button bindings handled by bindBtn() below

window.deleteImage = async (id) => {
    try {
        const res = await fetch(`/api/images/${id}/remove`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) showToast(data.error, true);
        else { showToast('Image deleted'); fetchImages(); fetchGlobalStats(); }
    } catch (err) {
        showToast(err.message, true);
    }
};

const fetchContainers = async () => {
    try {
        const res = await fetch('/api/containers');
        containersData = await res.json();
        renderContainers();
    } catch (error) {
        console.error("Failed to fetch containers", error);
    }
};

const renderContainers = () => {
    const filter = searchInput.value.toLowerCase();
    const statusVal = document.getElementById('status-filter').value;
    containerList.innerHTML = '';

    containersData.filter(c => {
        const name = c.Names[0].replace('/', '');
        const matchesSearch = name.toLowerCase().includes(filter) || c.Image.toLowerCase().includes(filter);
        const matchesStatus = statusVal === 'all' || c.State === statusVal;
        return matchesSearch && matchesStatus;
    }).forEach(c => {
        const name = c.Names[0].replace('/', '');
        const state = c.State; // running, exited, created

        const li = document.createElement('li');
        li.className = `container-item ${c.Id === activeContainerId ? 'active' : ''}`;
        li.onclick = () => selectContainer(c.Id, name, state);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'container-checkbox';
        checkbox.checked = selectedContainers.has(c.Id);
        checkbox.onclick = (e) => {
            e.stopPropagation();
            if (e.target.checked) selectedContainers.add(c.Id);
            else selectedContainers.delete(c.Id);
            updateBulkUI();
        };

        const statusDot = document.createElement('div');
        statusDot.className = `status-dot ${state}`;

        const infoList = document.createElement('div');
        infoList.className = 'container-info-list';
        infoList.innerHTML = `<div class="container-name">${name}</div><div class="container-image">${c.Image}</div>`;

        li.appendChild(checkbox);
        li.appendChild(statusDot);
        li.appendChild(infoList);

        containerList.appendChild(li);
    });
    updateBulkUI();
};

document.getElementById('status-filter').onchange = () => renderContainers();

selectAllCheckbox.addEventListener('change', (e) => {
    if (e.target.checked) {
        const filter = searchInput.value.toLowerCase();
        const statusVal = document.getElementById('status-filter').value;
        containersData.forEach(c => {
            const name = c.Names[0].replace('/', '');
            const matchesSearch = name.toLowerCase().includes(filter) || c.Image.toLowerCase().includes(filter);
            const matchesStatus = statusVal === 'all' || c.State === statusVal;
            if (matchesSearch && matchesStatus) selectedContainers.add(c.Id);
        });
    } else {
        selectedContainers.clear();
    }
    renderContainers();
});

// Auto-refresh global stats every 5s
setInterval(fetchGlobalStats, 5000);

const selectContainer = (id, name, state) => {
    if (activeContainerId === id) return;
    activeContainerId = id;
    renderContainers();

    // Update Header
    document.getElementById('top-context-title').textContent = `Container: ${name}`;
    document.getElementById('current-container-name').textContent = name;
    const statusBadge = document.getElementById('current-container-status');
    statusBadge.textContent = state.toUpperCase();
    statusBadge.className = `status-badge ${state}`;

    statCpu.textContent = '0.00';
    statMem.textContent = '0.00';
    containerStats.style.display = (state === 'running') ? 'flex' : 'none';

    welcomeMessage.style.display = 'none';
    logHeader.style.display = 'flex';
    logViewer.style.display = 'flex';
    logFooter.style.display = 'flex';

    logsContent.innerHTML = '';

    // Reset Charts
    labels.length = 0; cpuData.length = 0; memData.length = 0;
    cpuChart.update(); memChart.update();

    // Reset Terminal
    term.clear();

    // Switch to default tab
    document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.view-tab[data-view="logs"]').classList.add('active');
    switchTab('logs');

    // Connect Socket for logs
    if (socket.connected) socket.disconnect();

    socket.io.opts.query = { containerId: id };
    socket.connect();
};

const logFilter = document.getElementById('log-filter');

socket.on('log', (chunk) => {
    if (isLogPaused) return;

    const filterText = logFilter && logFilter.value ? logFilter.value.toLowerCase() : '';
    const lower = chunk.toLowerCase();

    if (filterText && !lower.includes(filterText)) return;

    const div = document.createElement('div');
    let className = 'log-line';

    if (lower.includes('error') || lower.includes('exception') || lower.includes('failed') || lower.includes('fatal')) {
        className += ' error';
    } else if (lower.includes('warn')) {
        className += ' warn';
    } else if (lower.includes('info') || lower.includes('success')) {
        className += ' info';
    }

    div.className = className;
    div.textContent = chunk;
    logsContent.appendChild(div);

    if (autoScroll) {
        logViewer.scrollTop = logViewer.scrollHeight;
    }
});

socket.on('stats', (data) => {
    statCpu.textContent = data.cpu;
    statMem.textContent = data.memory;

    if (labels.length > 20) {
        labels.shift(); cpuData.shift(); memData.shift();
    }

    const time = new Date().toLocaleTimeString();
    labels.push(time);
    cpuData.push(parseFloat(data.cpu));
    memData.push(parseFloat(data.memory));

    if (document.getElementById('stats-viewer').style.display !== 'none') {
        cpuChart.update();
        memChart.update();
    }
});

// Controls
searchInput.addEventListener('input', renderContainers);

document.getElementById('auto-scroll').addEventListener('change', (e) => {
    autoScroll = e.target.checked;
});

document.getElementById('btn-pause-logs').onclick = (e) => {
    isLogPaused = !isLogPaused;
    e.target.textContent = isLogPaused ? 'Resume Stream' : 'Pause Stream';
    e.target.style.borderColor = isLogPaused ? 'var(--green)' : 'var(--yellow)';
};

document.getElementById('btn-clear-logs').addEventListener('click', () => {
    logsContent.innerHTML = '';
});

// Download logs
document.getElementById('btn-download-logs').addEventListener('click', () => {
    const text = logsContent.innerText;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${document.getElementById('current-container-name').textContent}.txt`;
    a.click();
    URL.revokeObjectURL(url);
});

// Actions
const performAction = async (action) => {
    if (!activeContainerId) return;
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/${action}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(`Container ${action} success`);
        // Refresh
        setTimeout(fetchContainers, 1500);
    } catch (err) {
        showToast(`Error: ${err.message}`, true);
    }
};

const performBulkAction = async (action) => {
    if (!selectedContainers.size) return;
    try {
        await fetch('/api/containers/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, containerIds: Array.from(selectedContainers) })
        });
        setTimeout(fetchContainers, 1500);
    } catch (err) {
        showToast(err.message, true);
    }
};

document.getElementById('btn-bulk-start').onclick = () => performBulkAction('start');
document.getElementById('btn-bulk-stop').onclick = () => performBulkAction('stop');
document.getElementById('btn-bulk-remove').onclick = () => performBulkAction('remove');

document.getElementById('btn-start').onclick = () => performAction('start');
document.getElementById('btn-stop').onclick = () => performAction('stop');
document.getElementById('btn-restart').onclick = () => performAction('restart');

document.getElementById('btn-clone').onclick = () => {
    performAction('clone');
};

document.getElementById('btn-rename').onclick = async () => {
    const newName = prompt('Enter new container name:');
    if (!newName) return;
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(data.message);
        document.getElementById('current-container-name').textContent = newName;
        fetchContainers();
    } catch (err) { showToast(err.message, true); }
};

document.getElementById('btn-snapshot').onclick = async () => {
    const tag = prompt('Enter image name (e.g. my-app:v2):');
    if (!tag) { showToast('Snapshot cancelled', true); return; }
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error, true); return; }
        showToast(data.message);
        fetchGlobalStats();
    } catch (err) { showToast(err.message, true); }
};

document.getElementById('update-restart-policy').onchange = async (e) => {
    if (!activeContainerId || !e.target.value) return;
    try {
        const res = await fetch(`/api/containers/${activeContainerId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restartPolicy: e.target.value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast('Restart policy updated!');
    } catch (err) {
        showToast(err.message, true);
    } finally {
        e.target.value = '';
    }
};

// Replace delete button action with custom modal
document.getElementById('btn-logout').onclick = () => {
    localStorage.removeItem('docker_jwt');
    localStorage.removeItem('docker_role');
    location.reload();
};

const deleteModal = document.getElementById('delete-modal');
document.getElementById('btn-remove').onclick = () => {
    if (!activeContainerId) return;
    deleteModal.classList.add('show');
};
document.querySelector('.close-delete-btn').onclick = () => deleteModal.classList.remove('show');
document.getElementById('btn-cancel-delete').onclick = () => deleteModal.classList.remove('show');

document.getElementById('btn-confirm-delete').onclick = async () => {
    deleteModal.classList.remove('show');
    const btn = document.getElementById('btn-remove');
    btn.disabled = true;
    try {
        await performAction('remove');
        logHeader.style.display = 'none';
        logViewer.style.display = 'none';
        logFooter.style.display = 'none';
        welcomeMessage.style.display = 'block';
        activeContainerId = null;
    } catch (err) {
        console.error(err);
    } finally {
        btn.disabled = false;
    }
};

// Modal Logic
const runModal = document.getElementById('run-modal');

const fetchNetworks = async () => {
    try {
        const res = await fetch('/api/networks');
        const networks = await res.json();
        const sel = document.getElementById('network-select');
        sel.innerHTML = '<option value="default">Default (bridge)</option>';
        networks.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n.Name;
            opt.textContent = `${n.Name} (${n.Driver})`;
            sel.appendChild(opt);
        });
    } catch { }
};

document.getElementById('btn-create-network').onclick = async () => {
    const name = document.getElementById('new-network-name').value.trim();
    if (!name) { showToast('Enter a network name', true); return; }
    try {
        const res = await fetch('/api/networks/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, driver: 'bridge' })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error, true); return; }
        showToast(data.message);
        document.getElementById('new-network-name').value = '';
        fetchNetworks();
    } catch (err) { showToast(err.message, true); }
};

const bindBtn = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
};

bindBtn('btn-run-cmd', () => { runModal.classList.add('show'); fetchNetworks(); });
bindBtn('btn-run-cmd-sidebar', () => openRunModal());
bindBtn('btn-run-cmd-images', () => openRunModal());
bindBtn('btn-show-build-modal', () => {
    document.getElementById('build-modal').classList.add('show');
    document.getElementById('build-log-content').innerHTML = 'Waiting for build to start...';
});

bindBtn('btn-show-password-modal', () => {
    document.getElementById('password-modal').classList.add('show');
});
const closePasswordBtn = document.querySelector('.close-password-btn');
if (closePasswordBtn) closePasswordBtn.onclick = () => { document.getElementById('password-modal').classList.remove('show'); };

bindBtn('btn-submit-password', async () => {
    const oldPassword = document.getElementById('change-old-password').value;
    const newPassword = document.getElementById('change-new-password').value;
    if (!oldPassword || !newPassword) return showToast('Please fill all fields', true);

    try {
        const res = await fetch('/api/users/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('docker_jwt')
            },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast('Password changed successfully');
        document.getElementById('password-modal').classList.remove('show');
        document.getElementById('change-old-password').value = '';
        document.getElementById('change-new-password').value = '';
    } catch (err) { showToast(err.message, true); }
});

const setupEnterKey = (inputId, btnId) => {
    const el = document.getElementById(inputId);
    if (el) el.onkeyup = (e) => { if (e.key === 'Enter') document.getElementById(btnId).click(); };
};
setupEnterKey('login-password', 'btn-login');
setupEnterKey('change-new-password', 'btn-submit-password');
setupEnterKey('change-old-password', 'btn-submit-password');

const closeBtn = document.querySelector('.close-btn');
if (closeBtn) closeBtn.onclick = () => { runModal.classList.remove('show'); };
bindBtn('btn-cancel-run', () => { runModal.classList.remove('show'); });

document.getElementById('btn-submit-run').onclick = async () => {
    const image = document.getElementById('image-name').value;
    const containerName = document.getElementById('new-container-name').value;
    const volumeName = document.getElementById('volume-name').value;

    const portMapStr = document.getElementById('port-mappings').value;
    const envVarStr = document.getElementById('env-vars').value;
    const restartPolicy = document.getElementById('restart-policy').value;
    const network = document.getElementById('network-select').value;

    const ports = portMapStr.split(',').map(p => p.trim()).filter(p => p);
    const envs = envVarStr.split(',').map(e => e.trim()).filter(e => e);

    const statusDiv = document.getElementById('run-status');
    const btn = document.getElementById('btn-submit-run');

    if (!image) {
        statusDiv.className = 'status-msg error';
        statusDiv.textContent = 'Image name is required';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Pulling & Running...';
    statusDiv.textContent = '';

    try {
        const res = await fetch('/api/containers/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image, containerName, volumeName, ports, envs, restartPolicy, network })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        statusDiv.className = 'status-msg success';
        statusDiv.textContent = 'Success! Fetching container...';

        setTimeout(() => {
            runModal.classList.remove('show');
            fetchContainers();
        }, 1500);
    } catch (err) {
        statusDiv.className = 'status-msg error';
        statusDiv.textContent = `Error: ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Run Container';
    }
};

// Init
if (localStorage.getItem('docker_jwt')) {
    fetchContainers();
}
setInterval(fetchContainers, 5000);
