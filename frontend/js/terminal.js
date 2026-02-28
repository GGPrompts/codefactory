// CodeFactory Terminal Manager
var CodeFactoryTerminals = (function() {
    'use strict';

    var terminals = {};  // floor_id -> { xterm, fitAddon, ws, connected, initialized, config, powered }
    var WS_BASE = 'ws://' + window.location.host + '/ws/';
    var existingSessions = {};
    var reconnectAttempts = {};
    var reconnectTimers = {};  // floor_id -> timeout id for reconnection

    // Check for existing tmux sessions on page load (for reconnection after refresh)
    function checkExistingSessions() {
        return fetch('/api/sessions')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.sessions) {
                    data.sessions.forEach(function(id) {
                        existingSessions[id] = true;
                    });
                    console.log('[CodeFactory] Existing sessions:', Object.keys(existingSessions));
                }
                return existingSessions;
            })
            .catch(function(e) {
                console.warn('[CodeFactory] Failed to check existing sessions:', e);
                return {};
            });
    }

    // Check on module load
    checkExistingSessions();

    // Industrial terminal theme matching the CSS palette
    var TERMINAL_THEME = {
        background: '#0d0d0d',      // near-black
        foreground: '#E8E4DC',      // dirty-white
        cursor: '#FFB800',          // hazard-yellow
        cursorAccent: '#1A1D1F',    // iron-black
        selectionBackground: 'rgba(255, 184, 0, 0.25)',  // hazard-yellow transparent
        selectionForeground: '#E8E4DC',
        // Standard ANSI colors (industrial tones)
        black: '#1A1D1F',
        red: '#D42C2C',
        green: '#2D8B47',
        yellow: '#FFB800',
        blue: '#4A7FB5',
        magenta: '#8B5A8B',
        cyan: '#4A9B9B',
        white: '#C5CED4',
        // Bright variants
        brightBlack: '#4A5459',
        brightRed: '#E8823A',
        brightGreen: '#3DAA5B',
        brightYellow: '#FFD84D',
        brightBlue: '#6B9FCF',
        brightMagenta: '#A87BA8',
        brightCyan: '#6BBFBF',
        brightWhite: '#E8E4DC',
    };

    // Resolve addon constructors - different CDN builds expose globals differently
    function resolveAddon(name) {
        var obj = window[name];
        if (!obj) return null;
        if (typeof obj === 'function') return obj;
        if (typeof obj[name] === 'function') return obj[name];
        if (typeof obj.default === 'function') return obj.default;
        return null;
    }

    /**
     * Power ON a floor: create xterm instance, connect WebSocket, spawn session.
     * @param {string} floorId - Numeric floor ID (e.g. "1", "2")
     * @param {object} config - Profile config { name, command, cwd, icon }
     * @returns {object} terminal entry
     */
    function powerOn(floorId, config) {
        // If already powered on, just return existing
        if (terminals[floorId] && terminals[floorId].powered) {
            return terminals[floorId];
        }

        var container = document.getElementById('terminal-' + floorId);
        if (!container) return null;

        // Show terminal container, hide offline card
        var floorSection = document.getElementById('floor-' + floorId);
        if (floorSection) {
            floorSection.classList.add('powered-on');
            floorSection.classList.remove('powered-off');
        }

        // Clear any previous terminal content
        container.innerHTML = '';

        var xterm = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: "'Share Tech Mono', 'Courier New', monospace",
            theme: TERMINAL_THEME,
            allowTransparency: false,
            scrollback: 0,  // tmux manages scrollback
            minimumContrastRatio: 4.5,
        });

        var FitAddonCtor = resolveAddon('FitAddon');
        var WebLinksAddonCtor = resolveAddon('WebLinksAddon');
        var CanvasAddonCtor = resolveAddon('CanvasAddon');

        var fitAddon = FitAddonCtor ? new FitAddonCtor() : null;
        var webLinksAddon = WebLinksAddonCtor ? new WebLinksAddonCtor() : null;

        if (fitAddon) xterm.loadAddon(fitAddon);
        if (webLinksAddon) xterm.loadAddon(webLinksAddon);
        xterm.open(container);

        // Try to load canvas addon for GPU rendering
        if (CanvasAddonCtor) {
            try {
                var canvasAddon = new CanvasAddonCtor();
                xterm.loadAddon(canvasAddon);
            } catch(e) {
                console.warn('CanvasAddon not available, using DOM renderer');
            }
        }

        if (fitAddon) fitAddon.fit();

        var entry = {
            xterm: xterm,
            fitAddon: fitAddon,
            ws: null,
            connected: false,
            initialized: true,
            powered: true,
            outputGuarded: true,
            outputBuffer: [],
            config: config || null,
            resizeObserver: null,
        };
        terminals[floorId] = entry;

        // Output guard: buffer output for first 1000ms to prevent escape sequence corruption
        setTimeout(function() {
            if (!entry.powered) return;
            entry.outputGuarded = false;
            entry.outputBuffer.forEach(function(data) {
                xterm.write(data);
            });
            entry.outputBuffer = [];
        }, 1000);

        // Handle user input
        xterm.onData(function(data) {
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                var encoded = btoa(unescape(encodeURIComponent(data)));
                entry.ws.send(JSON.stringify({
                    type: 'terminal-input',
                    data: encoded
                }));
            }
        });

        // ResizeObserver for container size changes
        var resizeTimeout = null;
        var resizeObserver = new ResizeObserver(function() {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(function() {
                if (fitAddon && entry.powered) fitAddon.fit();
                if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                    entry.ws.send(JSON.stringify({
                        type: 'terminal-resize',
                        cols: xterm.cols,
                        rows: xterm.rows
                    }));
                }
            }, 150);
        });
        resizeObserver.observe(container);
        entry.resizeObserver = resizeObserver;

        // Update status
        var statusEl = document.getElementById('status-' + floorId);
        if (statusEl) {
            statusEl.textContent = 'CONNECTING';
            statusEl.className = 'floor-status connecting';
        }

        // Connect WebSocket
        connectWebSocket(floorId);

        return entry;
    }

    /**
     * Power OFF a floor: disconnect WebSocket, destroy xterm, show offline card.
     * The tmux session is preserved on the backend.
     * @param {string} floorId
     */
    function powerOff(floorId) {
        var entry = terminals[floorId];
        if (!entry) return;

        entry.powered = false;

        // Cancel any pending reconnection
        if (reconnectTimers[floorId]) {
            clearTimeout(reconnectTimers[floorId]);
            delete reconnectTimers[floorId];
        }

        // Close WebSocket without triggering reconnect
        if (entry.ws) {
            entry.ws.onclose = null;
            entry.ws.onerror = null;
            entry.ws.close();
            entry.ws = null;
        }

        // Disconnect resize observer
        if (entry.resizeObserver) {
            entry.resizeObserver.disconnect();
            entry.resizeObserver = null;
        }

        // Destroy xterm instance
        if (entry.xterm) {
            entry.xterm.dispose();
            entry.xterm = null;
        }

        entry.connected = false;
        entry.initialized = false;
        delete terminals[floorId];
        reconnectAttempts[floorId] = 0;

        // Clear terminal container
        var container = document.getElementById('terminal-' + floorId);
        if (container) {
            container.innerHTML = '';
        }

        // Toggle UI state
        var floorSection = document.getElementById('floor-' + floorId);
        if (floorSection) {
            floorSection.classList.remove('powered-on');
            floorSection.classList.add('powered-off');
        }

        // Update status
        var statusEl = document.getElementById('status-' + floorId);
        if (statusEl) {
            statusEl.textContent = 'OFFLINE';
            statusEl.className = 'floor-status offline';
        }
    }

    function connectWebSocket(floorId) {
        var entry = terminals[floorId];
        if (!entry || !entry.powered) return;

        var attempts = reconnectAttempts[floorId] || 0;
        var statusEl = document.getElementById('status-' + floorId);
        if (statusEl) {
            if (attempts > 0) {
                statusEl.textContent = 'RECONNECTING (' + attempts + ')';
            } else {
                statusEl.textContent = 'CONNECTING';
            }
            statusEl.className = 'floor-status connecting';
        }

        var ws = new WebSocket(WS_BASE + floorId);
        entry.ws = ws;

        ws.onopen = function() {
            console.log('[Floor ' + floorId + '] WebSocket connected');
            reconnectAttempts[floorId] = 0;
        };

        ws.onmessage = function(event) {
            var msg;
            try {
                msg = JSON.parse(event.data);
            } catch(e) {
                console.warn('[Floor ' + floorId + '] Failed to parse message:', e);
                return;
            }

            switch (msg.type) {
                case 'connected':
                    var isReconnect = existingSessions[floorId];
                    var cfg = entry.config;
                    console.log('[Floor ' + floorId + '] Server confirmed connection, sending spawn' +
                        (isReconnect ? ' (reconnect)' : ''));
                    ws.send(JSON.stringify({
                        type: 'terminal-spawn',
                        cols: entry.xterm.cols,
                        rows: entry.xterm.rows,
                        command: isReconnect ? null : (cfg ? cfg.command : null),
                        cwd: isReconnect ? null : (cfg ? cfg.cwd : null)
                    }));
                    if (isReconnect) {
                        delete existingSessions[floorId];
                    }
                    break;

                case 'terminal-spawned':
                    console.log('[Floor ' + floorId + '] Terminal spawned:', msg.cols + 'x' + msg.rows);
                    entry.connected = true;
                    if (statusEl) {
                        statusEl.textContent = 'ONLINE';
                        statusEl.className = 'floor-status online';
                    }
                    setTimeout(function() {
                        if (entry.fitAddon && entry.powered) entry.fitAddon.fit();
                        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'terminal-resize',
                                cols: entry.xterm.cols,
                                rows: entry.xterm.rows
                            }));
                        }
                    }, 100);
                    break;

                case 'terminal-output':
                    try {
                        var decoded = atob(msg.data);
                        var bytes = new Uint8Array(decoded.length);
                        for (var i = 0; i < decoded.length; i++) {
                            bytes[i] = decoded.charCodeAt(i);
                        }
                        if (entry.outputGuarded) {
                            entry.outputBuffer.push(bytes);
                        } else {
                            entry.xterm.write(bytes);
                        }
                    } catch(e) {
                        console.warn('[Floor ' + floorId + '] Failed to decode output:', e);
                    }
                    break;

                case 'terminal-closed':
                    console.log('[Floor ' + floorId + '] Terminal closed by server');
                    entry.connected = false;
                    if (statusEl) {
                        statusEl.textContent = 'OFFLINE';
                        statusEl.className = 'floor-status offline';
                    }
                    break;

                case 'terminal-error':
                    console.error('[Floor ' + floorId + '] Error:', msg.message);
                    if (statusEl) {
                        statusEl.textContent = 'ERROR';
                        statusEl.className = 'floor-status error';
                    }
                    break;
            }
        };

        ws.onclose = function() {
            if (!entry.powered) return;  // Don't reconnect if powered off
            console.log('[Floor ' + floorId + '] WebSocket closed');
            entry.connected = false;
            var currentAttempts = reconnectAttempts[floorId] || 0;
            reconnectAttempts[floorId] = currentAttempts + 1;
            var delay = Math.min(1000 * Math.pow(2, currentAttempts), 10000);
            if (statusEl) {
                statusEl.textContent = 'RECONNECTING (' + (currentAttempts + 1) + ')';
                statusEl.className = 'floor-status connecting';
            }
            console.log('[Floor ' + floorId + '] Reconnecting in ' + delay + 'ms (attempt ' + (currentAttempts + 1) + ')');
            reconnectTimers[floorId] = setTimeout(function() {
                if (terminals[floorId] && terminals[floorId].powered && !terminals[floorId].connected) {
                    connectWebSocket(floorId);
                }
            }, delay);
        };

        ws.onerror = function(err) {
            console.error('[Floor ' + floorId + '] WebSocket error:', err);
        };
    }

    // Public API
    return {
        powerOn: powerOn,
        powerOff: powerOff,
        getTerminal: function(floorId) { return terminals[floorId]; },
        isInitialized: function(floorId) { return !!terminals[floorId]; },
        isPowered: function(floorId) { return !!(terminals[floorId] && terminals[floorId].powered); },
        checkExistingSessions: checkExistingSessions,
        getExistingSessions: function() { return existingSessions; },
        // Legacy compat
        init: powerOn,
    };
})();
