// CodeFactory Terminal Manager
var CodeFactoryTerminals = (function() {
    'use strict';

    var terminals = {};  // floor_id -> { xterm, fitAddon, ws, connected, initialized, config }
    var WS_BASE = 'ws://' + window.location.host + '/ws/';
    var existingSessions = {};
    var reconnectAttempts = {};

    // Check for existing tmux sessions on page load (for reconnection after refresh)
    function checkExistingSessions() {
        fetch('/api/sessions')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.sessions) {
                    data.sessions.forEach(function(id) {
                        existingSessions[id] = true;
                    });
                    console.log('[CodeFactory] Existing sessions:', Object.keys(existingSessions));
                }
            })
            .catch(function(e) {
                console.warn('[CodeFactory] Failed to check existing sessions:', e);
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
        // Try common patterns: window.FitAddon.FitAddon, window.FitAddon, etc.
        var obj = window[name];
        if (!obj) return null;
        if (typeof obj === 'function') return obj;
        if (typeof obj[name] === 'function') return obj[name];
        // Try default export
        if (typeof obj.default === 'function') return obj.default;
        return null;
    }

    function initTerminal(floorId, config) {
        var container = document.getElementById('terminal-' + floorId);
        if (!container || terminals[floorId]) return;

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
            outputGuarded: true,
            outputBuffer: [],
            config: config || null,
        };
        terminals[floorId] = entry;

        // Output guard: buffer output for first 1000ms to prevent escape sequence corruption
        setTimeout(function() {
            entry.outputGuarded = false;
            // Flush buffered output
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
                if (fitAddon) fitAddon.fit();
                // Send resize to backend
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

        // Connect WebSocket
        connectWebSocket(floorId);

        return entry;
    }

    function connectWebSocket(floorId) {
        var entry = terminals[floorId];
        if (!entry) return;

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
            reconnectAttempts[floorId] = 0;  // reset on success
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
                    // If reconnecting to existing session, don't re-run the command
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
                        delete existingSessions[floorId];  // consumed
                    }
                    break;

                case 'terminal-spawned':
                    console.log('[Floor ' + floorId + '] Terminal spawned:', msg.cols + 'x' + msg.rows);
                    entry.connected = true;
                    if (statusEl) {
                        statusEl.textContent = 'ONLINE';
                        statusEl.className = 'floor-status online';
                    }
                    // Send initial resize with actual terminal dimensions
                    setTimeout(function() {
                        if (entry.fitAddon) entry.fitAddon.fit();
                        ws.send(JSON.stringify({
                            type: 'terminal-resize',
                            cols: entry.xterm.cols,
                            rows: entry.xterm.rows
                        }));
                    }, 100);
                    break;

                case 'terminal-output':
                    // Decode base64 output
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
            setTimeout(function() {
                if (terminals[floorId] && !terminals[floorId].connected) {
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
        init: initTerminal,
        getTerminal: function(floorId) { return terminals[floorId]; },
        isInitialized: function(floorId) { return !!terminals[floorId]; },
        checkExistingSessions: checkExistingSessions,
    };
})();
