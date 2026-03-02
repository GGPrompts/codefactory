// CodeFactory Terminal Manager  (v3 — mouse guard)
var CodeFactoryTerminals = (function() {
    'use strict';
    console.log('[CodeFactory] terminal.js v3 loaded (mouse guard)');

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

        // Force reflow after display:none → display:flex transition so
        // xterm.open() and fitAddon.fit() get correct container dimensions.
        void container.offsetHeight;

        // Clear any previous terminal content
        container.innerHTML = '';

        var xterm = new Terminal({
            cursorBlink: true,
            fontSize: 16,
            fontFamily: "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'DejaVu Sans Mono', 'Menlo', 'Consolas', monospace",
            theme: TERMINAL_THEME,
            allowTransparency: false,
            allowProposedApi: true,
            scrollback: 0,  // tmux manages scrollback
            minimumContrastRatio: 4.5,
        });

        var FitAddonCtor = resolveAddon('FitAddon');
        var WebLinksAddonCtor = resolveAddon('WebLinksAddon');
        var CanvasAddonCtor = resolveAddon('CanvasAddon');
        var Unicode11AddonCtor = resolveAddon('Unicode11Addon');

        var fitAddon = FitAddonCtor ? new FitAddonCtor() : null;
        var webLinksAddon = WebLinksAddonCtor ? new WebLinksAddonCtor() : null;

        if (fitAddon) xterm.loadAddon(fitAddon);
        if (webLinksAddon) xterm.loadAddon(webLinksAddon);

        // Load Unicode11 addon before open (registers the provider)
        if (Unicode11AddonCtor) {
            try {
                var unicode11Addon = new Unicode11AddonCtor();
                xterm.loadAddon(unicode11Addon);
            } catch(e) {
                console.warn('Unicode11Addon not available');
            }
        }

        xterm.open(container);

        // Activate Unicode 11 width tables after open() so DOM measurements are ready
        if (unicode11Addon) {
            xterm.unicode.activeVersion = '11';
        }

        // Disable browser right-click menu so tmux menus work
        container.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });

        // Block mouse events at the DOM level during the guard period.
        // xterm.js converts browser mouse events into SGR escape sequences
        // and sends them via onData. On reconnect, even passive hovering
        // generates mouse-motion sequences that tmux/TUI apps misinterpret.
        // Capturing at the DOM level prevents xterm from ever seeing them.
        var mouseBlocker = function(e) {
            e.stopPropagation();
            e.preventDefault();
        };
        ['mousedown', 'mouseup', 'mousemove', 'wheel', 'click', 'dblclick'].forEach(function(evt) {
            container.addEventListener(evt, mouseBlocker, true);
        });

        // Canvas renderer for GPU-accelerated rendering
        if (CanvasAddonCtor) {
            try {
                var canvasAddon = new CanvasAddonCtor();
                xterm.loadAddon(canvasAddon);
            } catch(e) {
                console.warn('CanvasAddon not available, using DOM renderer');
            }
        }

        if (fitAddon) fitAddon.fit();

        // Function to remove the mouse blocker listeners
        var mouseBlocked = true;
        var unblockMouse = function() {
            if (!mouseBlocked) return;
            mouseBlocked = false;
            ['mousedown', 'mouseup', 'mousemove', 'wheel', 'click', 'dblclick'].forEach(function(evt) {
                container.removeEventListener(evt, mouseBlocker, true);
            });
        };

        var entry = {
            xterm: xterm,
            fitAddon: fitAddon,
            ws: null,
            connected: false,
            initialized: true,
            powered: true,
            outputGuarded: true,
            inputGuarded: true,
            escGuarded: true,
            outputBuffer: [],
            config: config || null,
            resizeObserver: null,
            outputGuardTimer: null,
            inputGuardTimer: null,
            escGuardTimer: null,
            unblockMouse: unblockMouse,
        };
        terminals[floorId] = entry;

        // Output guard: buffer output to prevent escape sequence corruption.
        // Concatenate all buffered chunks into one Uint8Array before writing so
        // escape sequences that span chunk boundaries are not broken.
        // Timer is set here but RESET on terminal-spawned so the guard covers
        // the actual tmux redraw period, not just the DOM setup time.
        entry.flushOutputGuard = function() {
            if (!entry.powered) return;
            entry.outputGuarded = false;
            if (entry.outputBuffer.length > 0) {
                var totalLen = 0;
                entry.outputBuffer.forEach(function(chunk) { totalLen += chunk.length; });
                var merged = new Uint8Array(totalLen);
                var off = 0;
                entry.outputBuffer.forEach(function(chunk) {
                    merged.set(chunk, off);
                    off += chunk.length;
                });
                // Use write callback to know when xterm has finished
                // processing ALL buffered output (and generated any
                // auto-responses).  Only then drop the input guard.
                xterm.write(merged, function() {
                    // Allow a settling period for any trailing auto-responses
                    clearTimeout(entry.inputGuardTimer);
                    entry.inputGuardTimer = setTimeout(function() {
                        entry.inputGuarded = false;
                        entry.unblockMouse();
                    }, 500);
                });
            } else {
                clearTimeout(entry.inputGuardTimer);
                entry.inputGuardTimer = setTimeout(function() {
                    entry.inputGuarded = false;
                }, 500);
            }
            entry.outputBuffer = [];
        };
        entry.outputGuardTimer = setTimeout(entry.flushOutputGuard, 1000);

        // Input guard: stays up until the output guard flush completes AND
        // xterm finishes processing (see flushOutputGuard above).
        // The timer here is a fallback for cases where terminal-spawned
        // never arrives or the flush callback never fires.
        entry.inputGuardTimer = setTimeout(function() {
            entry.inputGuarded = false;
            entry.unblockMouse();
        }, 5000);

        // ESC guard: blocks ALL escape-sequence-starting data for longer
        // than the input guard to catch late auto-responses from tmux
        // reattach queries (DCS, DECRPM, etc.) that the regex may miss.
        entry.escGuardTimer = setTimeout(function() {
            entry.escGuarded = false;
        }, 8000);

        // Handle user input.
        // Permanently strip terminal auto-response patterns that xterm.js
        // generates when processing terminal output.  These must NOT be
        // relayed to tmux because with escape-time 0 tmux misparses them
        // as literal keypresses.  The regex catches complete responses;
        // any data starting with ESC that doesn't look like a user key
        // sequence is also blocked as a safety net for split chunks.
        var autoResponseRe = new RegExp(
            '\\x1b\\[\\?[0-9;]*c'           // DA1 response
            + '|\\x1b\\[>[0-9;]*c'           // DA2 response
            + '|\\x1b\\[=[0-9;]*c'           // DA3 response
            + '|\\x1b\\[[0-9;]*R'            // DSR cursor position report
            + '|\\x1b\\][0-9;]+;[^\\x07]*(?:\\x07|\\x1b\\\\)'  // OSC responses (e.g. color)
            + '|\\x1b\\[[IO]'                // Focus in/out reports
            + '|\\x1bP[^\\x1b]*\\x1b\\\\'   // DCS responses (XTVERSION, DECRQSS, etc.)
            + '|\\x1bP[^\\x07]*\\x07'        // DCS responses (BEL-terminated)
            + '|\\x1b\\[\\?[0-9;]*\\$y'      // DECRPM mode reports
            + '|\\x1b\\[\\?[0-9;]*u'         // Kitty keyboard mode report
            + '|\\x1b\\[[0-9;]*t'            // Window manipulation responses
        , 'g');
        xterm.onData(function(data) {
            if (entry.inputGuarded) {
                return;
            }
            // After reconnection, block ALL ESC-starting data for a longer
            // period to catch any auto-responses not covered by the regex.
            if (entry.escGuarded && data.charCodeAt(0) === 0x1b) {
                return;
            }
            var filtered = data.replace(autoResponseRe, '');
            if (filtered.length === 0) return;
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                var encoded = btoa(unescape(encodeURIComponent(filtered)));
                entry.ws.send(JSON.stringify({
                    type: 'terminal-input',
                    data: encoded
                }));
            }
        });

        // ResizeObserver for container size changes
        var resizeTimeout = null;
        entry.lastSentCols = 0;
        entry.lastSentRows = 0;
        var resizeObserver = new ResizeObserver(function() {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(function() {
                if (fitAddon && entry.powered) fitAddon.fit();
                // Only send resize if dimensions actually changed
                if (xterm.cols !== entry.lastSentCols || xterm.rows !== entry.lastSentRows) {
                    entry.lastSentCols = xterm.cols;
                    entry.lastSentRows = xterm.rows;
                    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                        entry.ws.send(JSON.stringify({
                            type: 'terminal-resize',
                            cols: xterm.cols,
                            rows: xterm.rows
                        }));
                    }
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
     * Tear down the frontend side of a floor (shared by detach and kill).
     * @param {string} floorId
     * @param {string} wsMessage - WebSocket message type to send before closing
     */
    function teardown(floorId, wsMessage) {
        var entry = terminals[floorId];
        if (!entry) return;

        entry.powered = false;

        // Cancel any pending reconnection
        if (reconnectTimers[floorId]) {
            clearTimeout(reconnectTimers[floorId]);
            delete reconnectTimers[floorId];
        }

        // Cancel guard timers and mouse blocker
        clearTimeout(entry.outputGuardTimer);
        clearTimeout(entry.inputGuardTimer);
        clearTimeout(entry.escGuardTimer);
        entry.unblockMouse();

        // Tell the backend what to do before closing
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({ type: wsMessage }));
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

    /**
     * Detach from a floor: drop the PTY connection but preserve the tmux session.
     * Power On will reattach to the same session.
     */
    function detach(floorId) {
        teardown(floorId, 'terminal-disconnect');
    }

    /**
     * Kill a floor: destroy the PTY and the tmux session.
     * Power On will create a fresh session.
     */
    function kill(floorId) {
        teardown(floorId, 'terminal-close');
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
                    entry.lastSentCols = entry.xterm.cols;
                    entry.lastSentRows = entry.xterm.rows;
                    ws.send(JSON.stringify({
                        type: 'terminal-spawn',
                        cols: entry.xterm.cols,
                        rows: entry.xterm.rows,
                        command: isReconnect ? null : (cfg ? cfg.command : null),
                        cwd: isReconnect ? null : (cfg ? cfg.cwd : null)
                    }));
                    entry.isReconnect = !!isReconnect;
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

                    // Reset guards so they cover the actual data-flow period
                    // (tmux redraw + post-spawn resize), not just DOM setup time.
                    // Input guard stays up until the output flush completes
                    // AND xterm finishes processing (callback in flushOutputGuard).
                    entry.outputGuarded = true;
                    clearTimeout(entry.outputGuardTimer);
                    entry.outputGuardTimer = setTimeout(entry.flushOutputGuard, 1000);

                    entry.inputGuarded = true;
                    clearTimeout(entry.inputGuardTimer);
                    // Fallback: drop guard after 5s if flush callback never fires
                    entry.inputGuardTimer = setTimeout(function() {
                        entry.inputGuarded = false;
                        entry.unblockMouse();
                    }, 5000);

                    // Reset ESC guard: blocks escape-starting data longer
                    // than input guard to catch late tmux reattach queries
                    entry.escGuarded = true;
                    clearTimeout(entry.escGuardTimer);
                    entry.escGuardTimer = setTimeout(function() {
                        entry.escGuarded = false;
                    }, 8000);

                    // Re-fit after DOM settles; only send resize if
                    // dimensions actually changed from the spawn size.
                    var spawnCols = msg.cols;
                    var spawnRows = msg.rows;
                    setTimeout(function() {
                        if (entry.fitAddon && entry.powered) entry.fitAddon.fit();
                        if (entry.ws && entry.ws.readyState === WebSocket.OPEN &&
                            (entry.xterm.cols !== spawnCols || entry.xterm.rows !== spawnRows)) {
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
                    console.log('[Floor ' + floorId + '] Terminal exited');
                    teardown(floorId, 'terminal-disconnect');
                    break;

                case 'terminal-error':
                    console.error('[Floor ' + floorId + '] Error:', msg.message);
                    if (statusEl) {
                        statusEl.textContent = 'ERROR';
                        statusEl.className = 'floor-status error';
                    }
                    break;

                case 'session-status':
                    handleSessionStatus(msg);
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
                    // Re-check existing sessions before reconnecting so the
                    // spawn message correctly sends command: null for reattach.
                    fetch('/api/sessions')
                        .then(function(r) { return r.json(); })
                        .then(function(data) {
                            if (data.sessions) {
                                data.sessions.forEach(function(id) {
                                    existingSessions[id] = true;
                                });
                            }
                            connectWebSocket(floorId);
                        })
                        .catch(function() {
                            connectWebSocket(floorId);
                        });
                }
            }, delay);
        };

        ws.onerror = function(err) {
            console.error('[Floor ' + floorId + '] WebSocket error:', err);
        };
    }

    // ── Claude Session Status Handling ──────────────────────────────
    var sessionStatuses = {};  // floorId -> { status, currentTool, subagentCount }

    function handleSessionStatus(msg) {
        var fid = msg.floorId;
        if (!fid) return;

        sessionStatuses[fid] = {
            status: msg.status,
            currentTool: msg.currentTool || '',
            subagentCount: msg.subagentCount || 0,
        };

        // Update elevator button glow
        var btn = document.querySelector('.floor-btn[data-target="floor-' + fid + '"]');
        if (btn) {
            // Remove all claude status classes
            btn.classList.remove('claude-awaiting', 'claude-processing', 'claude-idle');

            switch (msg.status) {
                case 'awaiting_input':
                    btn.classList.add('claude-awaiting');
                    break;
                case 'processing':
                case 'tool_use':
                    btn.classList.add('claude-processing');
                    break;
                case 'idle':
                    btn.classList.add('claude-idle');
                    break;
            }

            // Update tooltip with status info
            var label = btn.getAttribute('data-label') || '';
            var baseName = label.replace(/ \[.*\]$/, '');  // strip previous status suffix
            var statusSuffix = '';
            if (msg.status === 'awaiting_input') {
                statusSuffix = ' [AWAITING INPUT]';
            } else if (msg.status === 'tool_use' && msg.currentTool) {
                statusSuffix = ' [' + msg.currentTool + ']';
            } else if (msg.status === 'processing') {
                statusSuffix = ' [PROCESSING]';
            }
            btn.setAttribute('data-label', baseName + statusSuffix);
        }

        // Update floor header status badge if this floor is active (powered on)
        var floorStatusEl = document.getElementById('status-' + fid);
        if (floorStatusEl) {
            var entry = terminals[fid];
            if (entry && entry.powered && entry.connected) {
                floorStatusEl.classList.remove('claude-header-awaiting', 'claude-header-processing');
                switch (msg.status) {
                    case 'awaiting_input':
                        floorStatusEl.textContent = 'AWAITING INPUT';
                        floorStatusEl.className = 'floor-status online claude-header-awaiting';
                        break;
                    case 'processing':
                        floorStatusEl.textContent = 'PROCESSING';
                        floorStatusEl.className = 'floor-status online claude-header-processing';
                        break;
                    case 'tool_use':
                        floorStatusEl.textContent = msg.currentTool ? msg.currentTool.toUpperCase() : 'TOOL USE';
                        floorStatusEl.className = 'floor-status online claude-header-processing';
                        break;
                    case 'idle':
                        floorStatusEl.textContent = 'ONLINE';
                        floorStatusEl.className = 'floor-status online';
                        break;
                }
            }
        }
    }

    // Fetch initial session statuses on load
    function fetchInitialStatuses() {
        fetch('/api/session-status')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data && data.statuses) {
                    data.statuses.forEach(function(s) {
                        handleSessionStatus(s);
                    });
                }
            })
            .catch(function(e) {
                console.warn('[CodeFactory] Failed to fetch session statuses:', e);
            });
    }

    // Check initial statuses after a short delay (DOM needs to be ready)
    setTimeout(fetchInitialStatuses, 1500);

    // Suppress input to all terminals during page unload / refresh so that
    // stray keystrokes (Enter from address bar, browser shortcut keys) don't
    // leak into focused tmux panes right before navigation.
    window.addEventListener('beforeunload', function() {
        Object.keys(terminals).forEach(function(id) {
            var entry = terminals[id];
            if (entry) entry.inputGuarded = true;
        });
    });

    /**
     * Focus the xterm instance for a given floor so it receives keyboard input.
     * @param {string} floorId
     */
    function focusTerminal(floorId) {
        var entry = terminals[floorId];
        if (entry && entry.xterm) {
            entry.xterm.focus();
        }
    }

    // Public API
    return {
        powerOn: powerOn,
        detach: detach,
        kill: kill,
        focus: focusTerminal,
        getTerminal: function(floorId) { return terminals[floorId]; },
        isInitialized: function(floorId) { return !!terminals[floorId]; },
        isPowered: function(floorId) { return !!(terminals[floorId] && terminals[floorId].powered); },
        checkExistingSessions: checkExistingSessions,
        getExistingSessions: function() { return existingSessions; },
        getSessionStatus: function(floorId) { return sessionStatuses[floorId]; },
        // Legacy compat
        init: powerOn,
    };
})();
