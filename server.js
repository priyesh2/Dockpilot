const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const path = require('path');
const stream = require('stream');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const yaml = require('js-yaml');

const SECRET_KEY = process.env.JWT_SECRET || 'super-secret-key-123';

const USERS_FILE = path.join(__dirname, 'users.json');
const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');

const getUsers = () => {
    try {
        if (!fs.existsSync(USERS_FILE)) {
            const defaultUsers = [{ id: '1', username: 'admin', password: hashPassword('admin'), role: 'admin' }];
            fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
            return defaultUsers;
        }
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch {
        return [];
    }
};
const saveUsers = (data) => fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Utility: parse duration strings like "30s", "5m", "1h" to nanoseconds
const parseDuration = (str) => {
    if (!str) return 0;
    const s = String(str).toLowerCase().trim();
    const num = parseFloat(s);
    if (s.endsWith('ns')) return num;
    if (s.endsWith('us') || s.endsWith('µs')) return num * 1000;
    if (s.endsWith('ms')) return num * 1e6;
    if (s.endsWith('s') && !s.endsWith('ms') && !s.endsWith('ns') && !s.endsWith('us')) return num * 1e9;
    if (s.endsWith('m') && !s.endsWith('ms')) return num * 60 * 1e9;
    if (s.endsWith('h')) return num * 3600 * 1e9;
    return parseInt(s) || 0;
};

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory activity log + notifications
const activityLog = [];
const notifications = [];
const logActivity = (user, action, details = '') => {
    const entry = { user: user || 'system', action, details, time: new Date().toISOString() };
    activityLog.unshift(entry);
    if (activityLog.length > 200) activityLog.pop();
    // Also push to notifications
    notifications.unshift({ id: Date.now(), ...entry, read: false });
    if (notifications.length > 50) notifications.pop();
    // Emit real-time notification
    io.emit('notification', entry);
};

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username && u.password === hashPassword(password));
    if (user) {
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY, { expiresIn: '24h' });
        logActivity(user.username, 'login', 'Logged in');
        res.json({ token, role: user.role, username: user.username });
    } else {
        res.status(401).json({ error: 'Invalid username or password' });
    }
});

const authMiddleware = (req, res, next) => {
    if (req.path === '/login') return next();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const decoded = jwt.verify(authHeader.split(' ')[1], SECRET_KEY);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const rbacMiddleware = (req, res, next) => {
    if (req.user && req.user.role === 'viewer' && req.method !== 'GET' && req.path !== '/login') {
        return res.status(403).json({ error: 'Forbidden: Viewers cannot perform actions' });
    }
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') next();
    else res.status(403).json({ error: 'Forbidden: Admins Only' });
};

app.use('/api', authMiddleware, rbacMiddleware);

// ========== DASHBOARD STATS ==========
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        const info = await docker.info();
        const images = await docker.listImages();
        const containers = await docker.listContainers({ all: true });
        const volumes = await docker.listVolumes();
        const networks = await docker.listNetworks();

        // Health distribution
        let healthy = 0, unhealthy = 0, noHealthcheck = 0, starting = 0;
        for (const c of containers) {
            if (c.State !== 'running') continue;
            try {
                const detail = await docker.getContainer(c.Id).inspect();
                const hs = detail.State.Health ? detail.State.Health.Status : 'none';
                if (hs === 'healthy') healthy++;
                else if (hs === 'unhealthy') unhealthy++;
                else if (hs === 'starting') starting++;
                else noHealthcheck++;
            } catch { noHealthcheck++; }
        }

        res.json({
            containersTotal: info.Containers,
            containersRunning: info.ContainersRunning,
            containersStopped: info.ContainersStopped,
            containersPaused: info.ContainersPaused,
            imagesTotal: images.length,
            volumesTotal: (volumes.Volumes || []).length,
            networksTotal: networks.length,
            memTotal: (info.MemTotal / 1024 / 1024 / 1024).toFixed(2),
            ncpu: info.NCPU,
            operatingSystem: info.OperatingSystem,
            dockerVersion: info.ServerVersion,
            healthDistribution: { healthy, unhealthy, starting, noHealthcheck },
            recentActivity: activityLog.slice(0, 10)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== SYSTEM INFO ==========
app.get('/api/system/info', async (req, res) => {
    try {
        const info = await docker.info();
        const images = await docker.listImages();
        res.json({
            containersTotal: info.Containers,
            containersRunning: info.ContainersRunning,
            imagesTotal: images.length,
            memTotal: (info.MemTotal / 1024 / 1024 / 1024).toFixed(2),
            ncpu: info.NCPU,
            operatingSystem: info.OperatingSystem,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== SYSTEM DISK USAGE ==========
app.get('/api/system/disk', async (req, res) => {
    try {
        const df = await docker.df();
        const containerSize = (df.Containers || []).reduce((sum, c) => sum + (c.SizeRw || 0), 0);
        const imageSize = (df.Images || []).reduce((sum, i) => sum + (i.Size || 0), 0);
        const volumeSize = (df.Volumes || []).reduce((sum, v) => sum + (v.UsageData ? v.UsageData.Size : 0), 0);
        const buildCacheSize = (df.BuildCache || []).reduce((sum, b) => sum + (b.Size || 0), 0);

        res.json({
            containers: { count: (df.Containers || []).length, size: containerSize },
            images: { count: (df.Images || []).length, size: imageSize },
            volumes: { count: (df.Volumes || []).length, size: volumeSize },
            buildCache: { size: buildCacheSize },
            totalSize: containerSize + imageSize + volumeSize + buildCacheSize
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/system/prune', requireAdmin, async (req, res) => {
    try {
        const { type } = req.body;
        let result = {};
        if (type === 'containers') result = await docker.pruneContainers();
        else if (type === 'images') result = await docker.pruneImages();
        else if (type === 'volumes') result = await docker.pruneVolumes();
        else if (type === 'networks') result = await docker.pruneNetworks();
        else throw new Error('Invalid prune type');
        logActivity(req.user.username, 'prune', `Pruned ${type}`);
        res.json({ message: `${type} pruned successfully`, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== NOTIFICATIONS ==========
app.get('/api/notifications', (req, res) => {
    res.json(notifications);
});
app.post('/api/notifications/read', (req, res) => {
    notifications.forEach(n => n.read = true);
    res.json({ message: 'All marked as read' });
});

// ========== USER MANAGEMENT ==========
app.get('/api/users', requireAdmin, (req, res) => {
    res.json(getUsers().map(u => ({ id: u.id, username: u.username, role: u.role })));
});
app.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    const users = getUsers();
    if(users.some(u => u.username === username)) return res.status(400).json({ error: 'Username already exists' });
    users.push({ id: Date.now().toString(), username, password: hashPassword(password), role });
    saveUsers(users);
    logActivity(req.user.username, 'user-create', `Created user ${username}`);
    res.json({ message: 'User created successfully' });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
    if (String(req.params.id) === String(req.user.id)) return res.status(400).json({ error: 'Cannot delete yourself' });
    const users = getUsers();
    const filtered = users.filter(u => String(u.id) !== String(req.params.id));
    if (filtered.length === users.length) return res.status(404).json({ error: 'User not found' });
    saveUsers(filtered);
    res.json({ message: 'User deleted successfully' });
});
app.post('/api/users/change-password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Both old and new passwords are required' });
        const users = getUsers();
        const userIndex = users.findIndex(u => String(u.id) === String(req.user.id));
        if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
        if (users[userIndex].password !== hashPassword(oldPassword)) {
            return res.status(401).json({ error: 'Incorrect old password' });
        }
        users[userIndex].password = hashPassword(newPassword);
        saveUsers(users);
        logActivity(req.user.username, 'security', 'Changed password');
        res.json({ message: 'Password updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword) return res.status(400).json({ error: 'New password is required' });
        const users = getUsers();
        const userIndex = users.findIndex(u => String(u.id) === String(req.params.id));
        if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
        users[userIndex].password = hashPassword(newPassword);
        saveUsers(users);
        logActivity(req.user.username, 'security', `Reset password for ${users[userIndex].username}`);
        res.json({ message: `Password reset for ${users[userIndex].username}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== IMAGE MANAGEMENT ==========
app.get('/api/images', async (req, res) => {
    try {
        const images = await docker.listImages();
        res.json(images);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/images/:id/remove', async (req, res) => {
    try {
        const image = docker.getImage(req.params.id);
        await image.remove({ force: true });
        logActivity(req.user.username, 'delete-image', `Removed image ${req.params.id.substring(0,12)}`);
        res.json({ message: 'Image removed successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/images/:id/history', async (req, res) => {
    try {
        const image = docker.getImage(req.params.id);
        const history = await image.history();
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/images/search', async (req, res) => {
    try {
        const { term } = req.query;
        if (!term) return res.status(400).json({ error: 'Search term required' });
        const results = await docker.searchImages({ term, limit: 10 });
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/images/pull', requireAdmin, async (req, res) => {
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ error: 'Image name required' });
        await new Promise((resolve, reject) => {
            docker.pull(image, (err, stream) => {
                if (err) return reject(err);
                if (stream) {
                    docker.modem.followProgress(stream, (onFinishedErr) => {
                        if (onFinishedErr) return reject(onFinishedErr);
                        resolve();
                    });
                } else resolve();
            });
        });
        logActivity(req.user.username, 'pull', `Pulled image ${image}`);
        res.json({ message: `Image ${image} pulled successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const { spawn } = require('child_process');
app.post('/api/images/build', requireAdmin, async (req, res) => {
    try {
        const { tag, dockerfile } = req.body;
        if (!tag || !dockerfile) return res.status(400).json({ error: 'Tag and Dockerfile content are required' });

        const tmpDir = path.join(__dirname, 'tmp-build-' + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), dockerfile);

        const tar = spawn('tar', ['-C', tmpDir, '-c', 'Dockerfile']);

        docker.buildImage(tar.stdout, { t: tag }, (err, stream) => {
            if (err) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                return res.status(500).json({ error: err.message });
            }

            docker.modem.followProgress(stream, (onFinishedErr, output) => {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                if (onFinishedErr) {
                    io.emit('build-status', { tag, status: 'error', error: onFinishedErr.message });
                } else {
                    io.emit('build-status', { tag, status: 'success' });
                    logActivity(req.user.username, 'build', `Built image ${tag}`);
                }
            }, (event) => {
                io.emit('build-progress', { tag, event });
            });

            res.json({ message: 'Build started' });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== CONTAINER MANAGEMENT ==========
app.get('/api/containers', async (req, res) => {
    try {
        const containers = await docker.listContainers({ all: true });
        res.json(containers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const containerAction = async (req, res, action) => {
    try {
        const container = docker.getContainer(req.params.id);
        await container[action]();
        logActivity(req.user ? req.user.username : 'unknown', action, `Container ${req.params.id.substring(0,12)}`);
        res.json({ message: `Container ${action}ed successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

app.post('/api/containers/:id/start', (req, res) => containerAction(req, res, 'start'));
app.post('/api/containers/:id/stop', (req, res) => containerAction(req, res, 'stop'));
app.post('/api/containers/:id/restart', (req, res) => containerAction(req, res, 'restart'));

app.post('/api/containers/:id/clone', async (req, res) => {
    try {
        const source = docker.getContainer(req.params.id);
        const info = await source.inspect();
        const newName = info.Name.replace('/', '') + '-clone-' + Math.floor(Math.random() * 10000);

        const config = {
            Image: info.Config.Image,
            name: newName,
            Env: info.Config.Env,
            Cmd: info.Config.Cmd,
            HostConfig: {
                Binds: info.HostConfig.Binds,
                PortBindings: info.HostConfig.PortBindings,
                RestartPolicy: info.HostConfig.RestartPolicy
            }
        };

        const newContainer = await docker.createContainer(config);
        await newContainer.start();
        logActivity(req.user.username, 'clone', `Cloned container ${newName}`);
        res.json({ message: 'Container cloned successfully', id: newContainer.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/containers/:id/commit', requireAdmin, async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const { tag } = req.body;
        if (!tag) return res.status(400).json({ error: 'Image name/tag is required' });
        await container.commit({ repo: tag });
        logActivity(req.user.username, 'snapshot', `Snapshot saved as ${tag}`);
        res.json({ message: `Container snapshot saved as ${tag}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/containers/:id/inspect', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const info = await container.inspect();
        res.json(info);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== CONTAINER HEALTH ==========
app.get('/api/containers/:id/health', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const info = await container.inspect();
        const health = info.State.Health || null;
        res.json({
            status: health ? health.Status : 'none',
            failingStreak: health ? health.FailingStreak : 0,
            log: health ? (health.Log || []).slice(-5) : []
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== CONTAINER RESOURCE LIMITS ==========
app.post('/api/containers/:id/update', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const updateConfig = {};
        if (req.body.restartPolicy) {
            updateConfig.RestartPolicy = { Name: req.body.restartPolicy };
        }
        if (req.body.cpuShares !== undefined) {
            updateConfig.CpuShares = parseInt(req.body.cpuShares);
        }
        if (req.body.memory !== undefined) {
            updateConfig.Memory = parseInt(req.body.memory);
        }
        if (req.body.memoryReservation !== undefined) {
            updateConfig.MemoryReservation = parseInt(req.body.memoryReservation);
        }
        await container.update(updateConfig);
        logActivity(req.user.username, 'update', `Updated container ${req.params.id.substring(0,12)}`);
        res.json({ message: 'Container updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== CONTAINER EXPORT/IMPORT ==========
app.get('/api/containers/:id/export-config', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const info = await container.inspect();
        const exportConfig = {
            Image: info.Config.Image,
            Env: info.Config.Env,
            Cmd: info.Config.Cmd,
            Labels: info.Config.Labels,
            ExposedPorts: info.Config.ExposedPorts,
            HostConfig: {
                Binds: info.HostConfig.Binds,
                PortBindings: info.HostConfig.PortBindings,
                RestartPolicy: info.HostConfig.RestartPolicy,
                NetworkMode: info.HostConfig.NetworkMode,
                Memory: info.HostConfig.Memory,
                CpuShares: info.HostConfig.CpuShares,
            },
            exportedAt: new Date().toISOString(),
            exportedFrom: info.Name
        };
        res.json(exportConfig);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/containers/import-config', requireAdmin, async (req, res) => {
    try {
        const config = req.body;
        if (!config.Image) return res.status(400).json({ error: 'Config must include Image field' });
        const createConfig = {
            Image: config.Image,
            Env: config.Env || [],
            Cmd: config.Cmd || null,
            Labels: config.Labels || {},
            ExposedPorts: config.ExposedPorts || {},
            HostConfig: config.HostConfig || {}
        };
        if (config.name) createConfig.name = config.name;
        const container = await docker.createContainer(createConfig);
        await container.start();
        logActivity(req.user.username, 'import', `Imported container from config`);
        res.json({ message: 'Container created from imported config', id: container.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/containers/:id/remove', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        await container.remove({ force: true });
        logActivity(req.user.username, 'remove', `Removed container ${req.params.id.substring(0,12)}`);
        res.json({ message: 'Container removed successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/containers/bulk', async (req, res) => {
    try {
        const { action, containerIds } = req.body;
        if (!containerIds || !Array.isArray(containerIds)) {
            return res.status(400).json({ error: 'Invalid container IDs' });
        }
        await Promise.all(containerIds.map(async (id) => {
            try {
                const container = docker.getContainer(id);
                if (action === 'remove') {
                    await container.remove({ force: true });
                } else if (['start', 'stop', 'restart'].includes(action)) {
                    await container[action]();
                }
            } catch (err) {
                console.error(`Error on bulk ${action} for ${id}:`, err);
            }
        }));
        logActivity(req.user.username, `bulk-${action}`, `Bulk ${action} on ${containerIds.length} containers`);
        res.json({ message: `Bulk ${action} completed successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/containers/:id/rename', requireAdmin, async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'New name is required' });
        await container.rename({ name });
        logActivity(req.user.username, 'rename', `Renamed container to ${name}`);
        res.json({ message: `Container renamed to ${name}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/containers/:id/diff', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const changes = await container.diff();
        res.json(changes || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/containers/:id/files', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const dirPath = req.query.path || '/';
        const exec = await container.exec({
            Cmd: ['ls', '-la', '--time-style=long-iso', dirPath],
            AttachStdout: true, AttachStderr: true
        });
        const execStream = await exec.start();
        let output = '';
        execStream.on('data', chunk => output += chunk.toString('utf8'));
        await new Promise(resolve => execStream.on('end', resolve));
        const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
        const files = lines.map(line => {
            const clean = line.replace(/^[\x00-\x1f]+/g, '').trim();
            const parts = clean.split(/\s+/);
            if (parts.length < 7) return null;
            return {
                perms: parts[0],
                size: parts[3],
                date: parts[4] + ' ' + parts[5],
                name: parts.slice(6).join(' '),
                isDir: parts[0].startsWith('d')
            };
        }).filter(Boolean).filter(f => f.name !== '.' && f.name !== '..');
        res.json({ path: dirPath, files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== VOLUME MANAGEMENT ==========
app.get('/api/volumes', async (req, res) => {
    try {
        const data = await docker.listVolumes();
        res.json(data.Volumes || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/volumes/:name', requireAdmin, async (req, res) => {
    try {
        const volume = docker.getVolume(req.params.name);
        await volume.remove();
        logActivity(req.user.username, 'delete-volume', `Removed volume ${req.params.name}`);
        res.json({ message: 'Volume removed successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/volumes/create', async (req, res) => {
    try {
        const volume = await docker.createVolume({ Name: req.body.name });
        logActivity(req.user.username, 'create-volume', `Created volume ${req.body.name}`);
        res.json(volume);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== NETWORK MANAGEMENT ==========
app.get('/api/networks', async (req, res) => {
    try {
        const networks = await docker.listNetworks();
        res.json(networks);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/networks/:id/inspect', async (req, res) => {
    try {
        const network = docker.getNetwork(req.params.id);
        const info = await network.inspect();
        res.json(info);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/networks/create', requireAdmin, async (req, res) => {
    try {
        const { name, driver } = req.body;
        if (!name) return res.status(400).json({ error: 'Network name is required' });
        const network = await docker.createNetwork({ Name: name, Driver: driver || 'bridge' });
        logActivity(req.user.username, 'create-network', `Created network ${name}`);
        res.json({ message: `Network '${name}' created`, id: network.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/networks/:id', requireAdmin, async (req, res) => {
    try {
        const network = docker.getNetwork(req.params.id);
        await network.remove();
        logActivity(req.user.username, 'delete-network', `Removed network`);
        res.json({ message: 'Network removed' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== DOCKER COMPOSE DEPLOY ==========
app.post('/api/compose/deploy', requireAdmin, async (req, res) => {
    try {
        const { yamlContent, projectName } = req.body;
        if (!yamlContent) return res.status(400).json({ error: 'YAML content is required' });

        const compose = yaml.load(yamlContent);
        const services = compose.services || {};
        const project = projectName || 'dockpilot';
        const results = [];

        // Create networks first
        const composeNetworks = compose.networks || {};
        for (const [netName] of Object.entries(composeNetworks)) {
            try {
                await docker.createNetwork({ Name: `${project}_${netName}`, Driver: 'bridge' });
            } catch (e) { /* may already exist */ }
        }

        // Create volumes
        const composeVolumes = compose.volumes || {};
        for (const [volName] of Object.entries(composeVolumes)) {
            try {
                await docker.createVolume({ Name: `${project}_${volName}` });
            } catch (e) { /* may already exist */ }
        }

        // Create and start services
        for (const [svcName, svc] of Object.entries(services)) {
            try {
                const image = svc.image || `${project}_${svcName}`;
                // Try pulling the image
                try {
                    await new Promise((resolve, reject) => {
                        docker.pull(image, (err, stream) => {
                            if (err) return reject(err);
                            if (stream) {
                                docker.modem.followProgress(stream, (e) => e ? reject(e) : resolve());
                            } else resolve();
                        });
                    });
                } catch (pullErr) {
                    results.push({ service: svcName, status: 'error', error: `Failed to pull ${image}: ${pullErr.message}` });
                    continue;
                }

                const config = {
                    Image: image,
                    name: `${project}_${svcName}`,
                    Env: svc.environment ? (Array.isArray(svc.environment) ? svc.environment : Object.entries(svc.environment).map(([k,v]) => `${k}=${v}`)) : [],
                    Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': svcName },
                    HostConfig: {}
                };

                // Port mappings
                if (svc.ports && svc.ports.length > 0) {
                    config.ExposedPorts = {};
                    config.HostConfig.PortBindings = {};
                    svc.ports.forEach(p => {
                        const ps = String(p).split(':');
                        if (ps.length === 2) {
                            const key = `${ps[1]}/tcp`;
                            config.ExposedPorts[key] = {};
                            config.HostConfig.PortBindings[key] = [{ HostPort: ps[0] }];
                        }
                    });
                }

                // Volume mounts
                if (svc.volumes && svc.volumes.length > 0) {
                    config.HostConfig.Binds = svc.volumes.map(v => {
                        const vs = String(v).split(':');
                        if (vs.length >= 2 && !vs[0].startsWith('/') && !vs[0].startsWith('.')) {
                            return `${project}_${vs[0]}:${vs.slice(1).join(':')}`;
                        }
                        return v;
                    });
                }

                // Network
                if (svc.networks) {
                    const firstNet = Array.isArray(svc.networks) ? svc.networks[0] : Object.keys(svc.networks)[0];
                    if (firstNet) config.HostConfig.NetworkMode = `${project}_${firstNet}`;
                }

                // Restart policy
                if (svc.restart) {
                    const rp = svc.restart === 'no' ? 'no' : svc.restart.replace(':', '-');
                    config.HostConfig.RestartPolicy = { Name: rp };
                }

                // CPU limits
                if (svc.cpus) {
                    config.HostConfig.NanoCpus = Math.round(parseFloat(svc.cpus) * 1e9);
                }
                if (svc.cpu_shares) {
                    config.HostConfig.CpuShares = parseInt(svc.cpu_shares);
                }
                if (svc.cpu_count) {
                    config.HostConfig.CpuCount = parseInt(svc.cpu_count);
                }
                if (svc.cpuset) {
                    config.HostConfig.CpusetCpus = String(svc.cpuset);
                }

                // Memory limits
                const parseMemStr = (str) => {
                    if (!str) return 0;
                    const s = String(str).toLowerCase().trim();
                    const num = parseFloat(s);
                    if (s.endsWith('g') || s.endsWith('gb')) return Math.round(num * 1024 * 1024 * 1024);
                    if (s.endsWith('m') || s.endsWith('mb')) return Math.round(num * 1024 * 1024);
                    if (s.endsWith('k') || s.endsWith('kb')) return Math.round(num * 1024);
                    return parseInt(s) || 0;
                };
                if (svc.mem_limit) {
                    config.HostConfig.Memory = parseMemStr(svc.mem_limit);
                }
                if (svc.mem_reservation || svc.memswap_limit) {
                    if (svc.mem_reservation) config.HostConfig.MemoryReservation = parseMemStr(svc.mem_reservation);
                    if (svc.memswap_limit) config.HostConfig.MemorySwap = parseMemStr(svc.memswap_limit);
                }

                // deploy.resources (Compose v3 style)
                if (svc.deploy && svc.deploy.resources) {
                    const limits = svc.deploy.resources.limits || {};
                    const reservations = svc.deploy.resources.reservations || {};
                    if (limits.cpus) config.HostConfig.NanoCpus = Math.round(parseFloat(limits.cpus) * 1e9);
                    if (limits.memory) config.HostConfig.Memory = parseMemStr(limits.memory);
                    if (reservations.cpus) { /* reservations are advisory, no direct docker API */ }
                    if (reservations.memory) config.HostConfig.MemoryReservation = parseMemStr(reservations.memory);
                }

                // Command, Entrypoint, Hostname
                if (svc.command) {
                    config.Cmd = Array.isArray(svc.command) ? svc.command : svc.command.split(/\s+/);
                }
                if (svc.entrypoint) {
                    config.Entrypoint = Array.isArray(svc.entrypoint) ? svc.entrypoint : [svc.entrypoint];
                }
                if (svc.hostname) config.Hostname = svc.hostname;
                if (svc.working_dir) config.WorkingDir = svc.working_dir;
                if (svc.privileged) config.HostConfig.Privileged = true;
                if (svc.tty) config.Tty = true;
                if (svc.stdin_open) config.OpenStdin = true;
                if (svc.stop_grace_period) { /* informational only */ }

                // Healthcheck
                if (svc.healthcheck) {
                    const hc = svc.healthcheck;
                    if (hc.disable) {
                        config.Healthcheck = { Test: ['NONE'] };
                    } else if (hc.test) {
                        config.Healthcheck = {
                            Test: Array.isArray(hc.test) ? hc.test : ['CMD-SHELL', hc.test],
                            Interval: parseDuration(hc.interval),
                            Timeout: parseDuration(hc.timeout),
                            Retries: parseInt(hc.retries) || 3,
                            StartPeriod: parseDuration(hc.start_period)
                        };
                    }
                }

                // Extra labels from compose
                if (svc.labels) {
                    const extraLabels = Array.isArray(svc.labels)
                        ? Object.fromEntries(svc.labels.map(l => { const [k,...v] = l.split('='); return [k, v.join('=')]; }))
                        : svc.labels;
                    Object.assign(config.Labels, extraLabels);
                }

                const container = await docker.createContainer(config);
                await container.start();
                results.push({ service: svcName, status: 'started', id: container.id });
            } catch (err) {
                results.push({ service: svcName, status: 'error', error: err.message });
            }
        }

        logActivity(req.user.username, 'compose-deploy', `Deployed stack '${project}' with ${Object.keys(services).length} services`);
        res.json({ message: 'Compose deployment completed', results });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== RUN CONTAINER ==========
app.post('/api/containers/run', async (req, res) => {
    try {
        const { image, volumeName, containerName } = req.body;

        await new Promise((resolve, reject) => {
            docker.pull(image, (err, stream) => {
                if (err) return reject(err);
                if (stream) {
                    docker.modem.followProgress(stream, (onFinishedErr) => {
                        if (onFinishedErr) return reject(onFinishedErr);
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        });

        const config = {
            Image: image,
            name: containerName || undefined,
            HostConfig: {}
        };

        if (volumeName) {
            config.HostConfig.Binds = [`${volumeName}:/data`];
        }

        if (req.body.envs && req.body.envs.length > 0) {
            config.Env = req.body.envs;
        }

        if (req.body.restartPolicy && req.body.restartPolicy !== 'none') {
            config.HostConfig.RestartPolicy = { Name: req.body.restartPolicy };
        }

        if (req.body.ports && req.body.ports.length > 0) {
            config.ExposedPorts = {};
            config.HostConfig.PortBindings = {};
            req.body.ports.forEach(mapping => {
                const parts = mapping.split(':');
                if (parts.length === 2) {
                    const hostPort = parts[0].trim();
                    const containerPort = parts[1].trim();
                    const portKey = containerPort.includes('/') ? containerPort : `${containerPort}/tcp`;
                    config.ExposedPorts[portKey] = {};
                    config.HostConfig.PortBindings[portKey] = [{ HostPort: hostPort }];
                }
            });
        }

        if (req.body.network && req.body.network !== 'default') {
            config.HostConfig.NetworkMode = req.body.network;
        }

        // CPU Limits
        const parseMemoryStr = (str) => {
            if (!str) return 0;
            const s = String(str).toLowerCase().trim();
            const num = parseFloat(s);
            if (s.endsWith('g') || s.endsWith('gb')) return Math.round(num * 1024 * 1024 * 1024);
            if (s.endsWith('m') || s.endsWith('mb')) return Math.round(num * 1024 * 1024);
            if (s.endsWith('k') || s.endsWith('kb')) return Math.round(num * 1024);
            return parseInt(s) || 0;
        };

        if (req.body.cpus) {
            config.HostConfig.NanoCpus = Math.round(parseFloat(req.body.cpus) * 1e9);
        }
        if (req.body.cpuShares) {
            config.HostConfig.CpuShares = parseInt(req.body.cpuShares);
        }
        if (req.body.memory) {
            config.HostConfig.Memory = parseMemoryStr(req.body.memory);
        }
        if (req.body.memReservation) {
            config.HostConfig.MemoryReservation = parseMemoryStr(req.body.memReservation);
        }

        // Advanced options
        if (req.body.hostname) {
            config.Hostname = req.body.hostname;
        }
        if (req.body.command) {
            config.Cmd = req.body.command.split(/\s+/);
        }
        if (req.body.privileged) {
            config.HostConfig.Privileged = true;
        }
        if (req.body.autoRemove) {
            config.HostConfig.AutoRemove = true;
        }
        if (req.body.tty !== undefined) {
            config.Tty = !!req.body.tty;
        }

        const container = await docker.createContainer(config);
        await container.start();
        logActivity(req.user ? req.user.username : 'unknown', 'run', `Started container from ${image}${req.body.cpus ? ` (${req.body.cpus} CPUs)` : ''}${req.body.memory ? ` (${req.body.memory} mem)` : ''}`);
        res.json({ message: 'Container started successfully', id: container.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== ACTIVITY LOG ==========
app.get('/api/activity', requireAdmin, (req, res) => {
    res.json(activityLog);
});

// ========== SOCKET.IO ==========
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

io.on('connection', (socket) => {
    const containerId = socket.handshake.query.containerId;
    if (!containerId) {
        // Global socket connection (for notifications etc)
        return;
    }

    const container = docker.getContainer(containerId);
    let logStream = null;
    let statsStream = null;

    const setupLogs = async () => {
        try {
            const info = await container.inspect();
            const streamOptions = {
                follow: true,
                stdout: true,
                stderr: true,
                tail: 500
            };

            logStream = await container.logs(streamOptions);

            if (info.Config.Tty) {
                logStream.on('data', chunk => socket.emit('log', chunk.toString('utf8')));
            } else {
                const stdout = new stream.PassThrough();
                const stderr = new stream.PassThrough();
                stdout.on('data', chunk => socket.emit('log', chunk.toString('utf8')));
                stderr.on('data', chunk => socket.emit('log', chunk.toString('utf8')));
                container.modem.demuxStream(logStream, stdout, stderr);
            }

            logStream.on('end', () => socket.emit('log', `\r\n--- Stream Ended ---\r\n`));
            logStream.on('error', err => socket.emit('log', `\r\n--- Stream Error: ${err.message} ---\r\n`));

        } catch (error) {
            socket.emit('log', `\r\n--- Error initializing stream: ${error.message} ---\r\n`);
        }
    };

    const setupStats = async () => {
        try {
            statsStream = await container.stats({ stream: true });
            let buffer = '';
            statsStream.on('data', chunk => {
                buffer += chunk.toString('utf8');
                let lines = buffer.split('\n');
                buffer = lines.pop();

                lines.forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed) return;
                    try {
                        const stats = JSON.parse(trimmed);
                        let cpuPercent = 0.0;

                        if (stats.cpu_stats && stats.precpu_stats) {
                            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
                            const systemCpuDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;

                            if (systemCpuDelta > 0 && cpuDelta > 0) {
                                const onlineCpus = stats.cpu_stats.online_cpus ||
                                    (stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
                                cpuPercent = (cpuDelta / systemCpuDelta) * onlineCpus * 100.0;
                            }
                        }

                        let memUsage = 0;
                        if (stats.memory_stats && stats.memory_stats.usage) {
                            memUsage = stats.memory_stats.usage;
                        }

                        socket.emit('stats', {
                            cpu: cpuPercent.toFixed(2),
                            memory: (memUsage / 1024 / 1024).toFixed(2)
                        });
                    } catch(e) {}
                });
            });
        } catch(error) {
            console.error('Stats stream error:', error);
        }
    };

    setupLogs();
    setupStats();

    let execStream = null;

    socket.on('exec-input', (data) => {
        if (execStream) execStream.write(data);
    });

    socket.on('exec-resize', (size) => {
        if (socket._currentExec && size && size.cols && size.rows) {
            socket._currentExec.resize({ h: size.rows, w: size.cols }).catch(() => {});
        }
    });

    socket.on('exec-start', async (options = { Cmd: ['/bin/sh'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true }) => {
        if (socket.user.role !== 'admin') {
            socket.emit('exec-output', '\r\nForbidden: Admins Only. You cannot run commands.\r\n');
            return;
        }
        if (execStream && execStream.end) execStream.end();

        try {
            const exec = await container.exec(options);
            socket._currentExec = exec;
            execStream = await exec.start({ hijack: true, stdin: true });

            if (options.Tty) {
                execStream.on('data', chunk => socket.emit('exec-output', chunk.toString('utf8')));
            } else {
                container.modem.demuxStream(execStream, {
                    write: (data) => socket.emit('exec-output', data.toString())
                }, {
                    write: (data) => socket.emit('exec-output', data.toString())
                });
            }

            execStream.on('end', () => socket.emit('exec-end'));

        } catch (error) {
            socket.emit('exec-output', `\r\nError starting exec: ${error.message}\r\n`);
        }
    });

    socket.on('disconnect', () => {
        if (logStream && logStream.destroy) logStream.destroy();
        if (statsStream && statsStream.destroy) statsStream.destroy();
        if (execStream && execStream.end) execStream.end();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`DockPilot Enterprise v2.0.0 (20 Features Edition) running on port ${PORT}`);
});
