const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const path = require('path');
const stream = require('stream');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory activity log
const activityLog = [];
const logActivity = (user, action, details = '') => {
    activityLog.unshift({ user: user || 'system', action, details, time: new Date().toISOString() });
    if (activityLog.length > 200) activityLog.pop();
};

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username && u.password === hashPassword(password));
    if (user) {
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET_KEY, { expiresIn: '24h' });
        logActivity(user.username, 'login', 'Logged in');
        res.json({ token, role: user.role });
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

// System-wide APIs
app.get('/api/system/info', async (req, res) => {
    try {
        const info = await docker.info();
        const images = await docker.listImages();
        const containers = await docker.listContainers({ all: true });
        res.json({
            containersTotal: info.Containers,
            containersRunning: info.ContainersRunning,
            imagesTotal: images.length,
            memTotal: (info.MemTotal / 1024 / 1024 / 1024).toFixed(2), // GB
            ncpu: info.NCPU,
            operatingSystem: info.OperatingSystem,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/system/prune', requireAdmin, async (req, res) => {
    try {
        const { type } = req.body; // containers, images, volumes, networks
        let result = {};
        if (type === 'containers') result = await docker.pruneContainers();
        else if (type === 'images') result = await docker.pruneImages();
        else if (type === 'volumes') result = await docker.pruneVolumes();
        else if (type === 'networks') result = await docker.pruneNetworks();
        else throw new Error('Invalid prune type');

        res.json({ message: `${type} pruned successfully`, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// User Management API
app.get('/api/users', requireAdmin, (req, res) => {
    res.json(getUsers().map(u => ({ id: u.id, username: u.username, role: u.role })));
});
app.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    const users = getUsers();
    if(users.some(u => u.username === username)) return res.status(400).json({ error: 'Username already exists' });
    users.push({ id: Date.now().toString(), username, password: hashPassword(password), role });
    saveUsers(users);
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

// API to list images
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

// API to list containers
app.get('/api/containers', async (req, res) => {
    try {
        const containers = await docker.listContainers({ all: true });
        res.json(containers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// APIs for container actions
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

app.post('/api/containers/:id/update', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const { restartPolicy } = req.body;
        await container.update({ RestartPolicy: { Name: restartPolicy } });
        res.json({ message: 'Restart policy updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/containers/:id/remove', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        await container.remove({ force: true });
        res.json({ message: 'Container removed successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bulk operations API
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
        res.json({ message: `Bulk ${action} completed successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// APIs for volume management
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
        res.json(volume);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Network Management APIs
app.get('/api/networks', async (req, res) => {
    try {
        const networks = await docker.listNetworks();
        res.json(networks);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/networks/create', requireAdmin, async (req, res) => {
    try {
        const { name, driver } = req.body;
        if (!name) return res.status(400).json({ error: 'Network name is required' });
        const network = await docker.createNetwork({ Name: name, Driver: driver || 'bridge' });
        res.json({ message: `Network '${name}' created`, id: network.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/networks/:id', requireAdmin, async (req, res) => {
    try {
        const network = docker.getNetwork(req.params.id);
        await network.remove();
        res.json({ message: 'Network removed' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API to run a container with a volume mount
app.post('/api/containers/run', async (req, res) => {
    try {
        const { image, volumeName, containerName } = req.body;
        
        // Ensure image exists or pull it
        await new Promise((resolve, reject) => {
            docker.pull(image, (err, stream) => {
                if (err) return reject(err);
                if (stream) {
                    docker.modem.followProgress(stream, (onFinishedErr, output) => {
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

        // Network config
        if (req.body.network && req.body.network !== 'default') {
            config.HostConfig.NetworkMode = req.body.network;
        }
        
        const container = await docker.createContainer(config);
        await container.start();
        res.json({ message: 'Container started successfully', id: container.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Socket.io for log streaming and exec

// Activity Log API
app.get('/api/activity', requireAdmin, (req, res) => {
    res.json(activityLog);
});

// Container file browser
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
        // Parse ls output
        const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('total'));
        const files = lines.map(line => {
            // Remove binary header bytes that docker multiplexing adds
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

// Image search (Docker Hub)
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

// Image pull
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

        // Remove -v to avoid corrupting the stream with file lists
        const tar = spawn('tar', ['-C', tmpDir, '-c', 'Dockerfile']);
        
        console.log(`Starting build for ${tag} in ${tmpDir}`);
        
        docker.buildImage(tar.stdout, { t: tag }, (err, stream) => {
            if (err) {
                console.error('Build init error:', err);
                fs.rmSync(tmpDir, { recursive: true, force: true });
                return res.status(500).json({ error: err.message });
            }
            
            docker.modem.followProgress(stream, (onFinishedErr, output) => {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                if (onFinishedErr) {
                    console.error('Build finish error:', onFinishedErr);
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

// Container rename
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

// Container diff (filesystem changes)
app.get('/api/containers/:id/diff', async (req, res) => {
    try {
        const container = docker.getContainer(req.params.id);
        const changes = await container.diff();
        // Kind: 0=Modified, 1=Added, 2=Deleted
        res.json(changes || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

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
        socket.disconnect();
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
            statsStream.on('data', chunk => {
                try {
                    const stats = JSON.parse(chunk.toString('utf8'));
                    let cpuPercent = 0.0;
                    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
                    const systemCpuDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
                    if (systemCpuDelta > 0 && cpuDelta > 0) {
                        const onlineCpus = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
                        cpuPercent = (cpuDelta / systemCpuDelta) * onlineCpus * 100.0;
                    }
                    const memUsage = stats.memory_stats.usage;
                    socket.emit('stats', {
                        cpu: cpuPercent.toFixed(2),
                        memory: (memUsage / 1024 / 1024).toFixed(2)
                    });
                } catch(e) {}
            });
        } catch(error) {}
    };

    setupLogs();
    setupStats();

    // Exec / Terminal feature
    let execStream = null;

    socket.on('exec-input', (data) => {
        if (execStream) execStream.write(data);
    });

    socket.on('exec-resize', (size) => {
        // resize is stored on current exec reference
        if (socket._currentExec && size && size.cols && size.rows) {
            socket._currentExec.resize({ h: size.rows, w: size.cols }).catch(() => {});
        }
    });

    socket.on('exec-start', async (options = { Cmd: ['/bin/sh'], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true }) => {
        if (socket.user.role !== 'admin') {
            socket.emit('exec-output', '\r\nForbidden: Admins Only. You cannot run commands.\r\n');
            return;
        }
        // Clean up previous exec stream
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
        if (logStream && logStream.destroy) {
            logStream.destroy();
        }
        if (statsStream && statsStream.destroy) {
            statsStream.destroy();
        }
        if (execStream && execStream.end) {
            execStream.end();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`DockPilot Enterprise v1.2.0 (Build Engine Live) running on port ${PORT}`);
});
