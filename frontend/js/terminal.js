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

        var isMobile = window.matchMedia('(max-width: 768px)').matches;
        var initialFontSize = isMobile ? 13 : 16;
        var xterm = new Terminal({
            cursorBlink: true,
            fontSize: initialFontSize,
            fontFamily: "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'DejaVu Sans Mono', 'Menlo', 'Consolas', monospace",
            theme: TERMINAL_THEME,
            allowTransparency: false,
            allowProposedApi: true,
            scrollback: 0,  // tmux manages scrollback
            minimumContrastRatio: 1,  // Trust our theme colors; skip per-cell contrast recalculation
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

        // Prevent mobile Chrome from scrolling the page when xterm's
        // hidden textarea receives focus.  The browser tries to scroll
        // the focused element into the visible viewport, but xterm
        // positions its textarea offscreen, causing the whole page to
        // jump.  We pin the textarea so focus doesn't trigger a scroll.
        var textarea = container.querySelector('.xterm-helper-textarea');
        if (textarea) {
            textarea.addEventListener('focus', function() {
                var floorSection = document.getElementById('floor-' + floorId);
                if (floorSection) {
                    requestAnimationFrame(function() {
                        floorSection.scrollIntoView({ behavior: 'instant', block: 'start' });
                    });
                }
            });
        }

        // Activate Unicode 11 width tables after open() so DOM measurements are ready
        if (unicode11Addon) {
            xterm.unicode.activeVersion = '11';
        }

        // Disable browser right-click menu so tmux menus work
        container.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });

        // Mobile: convert vertical touch-swipes into mouse scroll sequences
        // sent directly to tmux via the websocket.  tmux mouse mode expects
        // SGR mouse wheel escape sequences to enter copy-mode / scroll.
        (function() {
            var touchStartY = 0;
            var scrolling = false;
            var SCROLL_THRESHOLD = 20; // px per scroll tick
            var SCROLL_THROTTLE_MS = 50;
            var lastScrollSend = 0;

            // Pre-compute encoded scroll messages to avoid btoa/JSON.stringify per event
            var SCROLL_UP_MSG = JSON.stringify({ type: 'terminal-input', data: btoa('\x1b[<65;1;1M') });
            var SCROLL_DOWN_MSG = JSON.stringify({ type: 'terminal-input', data: btoa('\x1b[<64;1;1M') });

            container.addEventListener('touchstart', function(e) {
                if (e.touches.length === 1) {
                    touchStartY = e.touches[0].clientY;
                    scrolling = false;
                }
            }, { passive: true });

            container.addEventListener('touchmove', function(e) {
                if (e.touches.length !== 1) return;
                var dy = touchStartY - e.touches[0].clientY;
                if (Math.abs(dy) >= SCROLL_THRESHOLD) {
                    e.preventDefault(); // only prevent default once scrolling confirmed
                    scrolling = true;
                    var now = Date.now();
                    if (now - lastScrollSend >= SCROLL_THROTTLE_MS) {
                        if (entry.ws && entry.ws.readyState === WebSocket.OPEN && !entry.inputGuarded) {
                            entry.ws.send(dy > 0 ? SCROLL_UP_MSG : SCROLL_DOWN_MSG);
                        }
                        lastScrollSend = now;
                    }
                    touchStartY = e.touches[0].clientY;
                } else if (!scrolling) {
                    e.preventDefault(); // still block page scroll on terminal
                }
            }, { passive: false });

            container.addEventListener('touchend', function() {
                scrolling = false;
            }, { passive: true });
        })();

        // Mobile: pinch-to-zoom changes terminal font size (like Termux).
        // Intercepts the two-finger gesture, suppresses browser zoom, and
        // adjusts xterm fontSize.  fitAddon.fit() recalculates cols/rows
        // and the ResizeObserver sends the new dimensions to the backend.
        (function() {
            var MIN_FONT = 6;
            var MAX_FONT = 30;
            var initialDistance = 0;
            var initialFontSz = 0;
            var pinching = false;

            function touchDist(e) {
                var dx = e.touches[0].clientX - e.touches[1].clientX;
                var dy = e.touches[0].clientY - e.touches[1].clientY;
                return Math.sqrt(dx * dx + dy * dy);
            }

            container.addEventListener('touchstart', function(e) {
                if (e.touches.length === 2) {
                    pinching = true;
                    initialDistance = touchDist(e);
                    initialFontSz = xterm.options.fontSize;
                }
            }, { passive: true });

            container.addEventListener('touchmove', function(e) {
                if (!pinching || e.touches.length !== 2) return;
                e.preventDefault();
                var dist = touchDist(e);
                var scale = dist / initialDistance;
                var newSize = Math.round(initialFontSz * scale);
                newSize = Math.max(MIN_FONT, Math.min(MAX_FONT, newSize));
                if (newSize !== xterm.options.fontSize) {
                    xterm.options.fontSize = newSize;
                    if (fitAddon) fitAddon.fit();
                }
            }, { passive: false });

            container.addEventListener('touchend', function(e) {
                if (pinching && e.touches.length < 2) {
                    pinching = false;
                }
            }, { passive: true });
        })();

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

        // Canvas renderer for GPU-accelerated rendering (skip on mobile —
        // DOM renderer is faster and avoids main-thread canvas repaint jank)
        if (CanvasAddonCtor && !isMobile) {
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
            // If xterm has no dimensions yet (container not visible on mobile),
            // defer the flush until a resize gives it valid dimensions.
            if (xterm.rows === 0 || xterm.cols === 0) {
                entry.outputGuardTimer = setTimeout(entry.flushOutputGuard, 200);
                return;
            }
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
                    // Brief settling period for any trailing auto-responses
                    clearTimeout(entry.inputGuardTimer);
                    entry.inputGuardTimer = setTimeout(function() {
                        entry.inputGuarded = false;
                        entry.unblockMouse();
                    }, 200);
                });
            } else {
                clearTimeout(entry.inputGuardTimer);
                entry.inputGuardTimer = setTimeout(function() {
                    entry.inputGuarded = false;
                }, 200);
            }
            entry.outputBuffer = [];
        };
        entry.outputGuardTimer = setTimeout(entry.flushOutputGuard, 500);

        // Input guard: stays up until the output guard flush completes AND
        // xterm finishes processing (see flushOutputGuard above).
        // The timer here is a fallback for cases where terminal-spawned
        // never arrives or the flush callback never fires.
        entry.inputGuardTimer = setTimeout(function() {
            entry.inputGuarded = false;
            entry.unblockMouse();
        }, 2000);

        // ESC guard: blocks escape-sequence-starting data to catch
        // auto-responses (DA1, DCS, DECRPM, etc.) not covered by the
        // regex filter.  Short since the PTY now persists across
        // reconnections — no tmux reattach storm to absorb.
        entry.escGuardTimer = setTimeout(function() {
            entry.escGuarded = false;
        }, 2000);

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
        // Batch input: accumulate keystrokes for a few ms to reduce
        // per-keystroke WebSocket overhead (JSON + base64 + frame each way).
        // Single-character interactive typing flushes immediately (0ms latency);
        // multi-char data (pastes) batches briefly to coalesce into one frame.
        var inputBuf = '';
        var inputTimer = null;
        var INPUT_BATCH_MS = 8;

        function flushInput() {
            inputTimer = null;
            if (!inputBuf || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
                inputBuf = '';
                return;
            }
            var encoded = btoa(unescape(encodeURIComponent(inputBuf)));
            entry.ws.send(JSON.stringify({
                type: 'terminal-input',
                data: encoded
            }));
            inputBuf = '';
        }

        xterm.onData(function(data) {
            if (entry.inputGuarded) {
                return;
            }
            // After reconnection, block ALL ESC-starting data for a longer
            // period to catch any auto-responses not covered by the regex.
            if (entry.escGuarded && data.charCodeAt(0) === 0x1b) {
                return;
            }
            // Fast path: single printable character — skip regex
            var filtered = (data.length === 1 && data.charCodeAt(0) >= 0x20)
                ? data
                : data.replace(autoResponseRe, '');
            if (filtered.length === 0) return;
            // Single-char interactive typing: flush immediately for lowest latency.
            // Multi-char data (paste, escape sequences): batch to coalesce frames.
            if (filtered.length === 1 && !inputTimer) {
                inputBuf += filtered;
                flushInput();
            } else {
                inputBuf += filtered;
                if (!inputTimer) {
                    inputTimer = setTimeout(flushInput, INPUT_BATCH_MS);
                }
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
                    entry.outputGuarded = true;
                    clearTimeout(entry.outputGuardTimer);
                    entry.outputGuardTimer = setTimeout(entry.flushOutputGuard, 500);

                    entry.inputGuarded = true;
                    clearTimeout(entry.inputGuardTimer);
                    // Fallback: drop guard after 2s if flush callback never fires
                    entry.inputGuardTimer = setTimeout(function() {
                        entry.inputGuarded = false;
                        entry.unblockMouse();
                    }, 2000);

                    entry.escGuarded = true;
                    clearTimeout(entry.escGuardTimer);
                    entry.escGuardTimer = setTimeout(function() {
                        entry.escGuarded = false;
                    }, 2000);

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
                        var bytes = Uint8Array.from(decoded, function(c) { return c.charCodeAt(0); });
                        if (entry.outputGuarded) {
                            entry.outputBuffer.push(bytes);
                        } else if (entry.xterm.rows > 0 && entry.xterm.cols > 0) {
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

        // Defer DOM mutations to idle time to avoid blocking input processing
        var doDomUpdate = function() {
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
        };
        if (window.requestIdleCallback) {
            requestIdleCallback(doDomUpdate);
        } else {
            setTimeout(doDomUpdate, 0);
        }
    }

    // Fetch session statuses and update elevator button online indicators
    function fetchSessionStatuses() {
        fetch('/api/session-status')
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data && data.statuses) {
                    data.statuses.forEach(function(s) {
                        handleSessionStatus(s);
                    });
                }
                // Apply online glow to all active tmux floor buttons
                var allBtns = document.querySelectorAll('.floor-btn[data-target]');
                var activeSet = {};
                if (data && data.activeFloors) {
                    data.activeFloors.forEach(function(af) {
                        activeSet[af.floorId] = true;
                    });
                }
                allBtns.forEach(function(btn) {
                    var target = btn.getAttribute('data-target') || '';
                    var floorId = target.replace('floor-', '');
                    if (activeSet[floorId]) {
                        btn.classList.add('floor-online');
                    } else {
                        btn.classList.remove('floor-online');
                    }
                });
            })
            .catch(function(e) {
                console.warn('[CodeFactory] Failed to fetch session statuses:', e);
            });
    }

    // Check statuses after a short delay (DOM needs to be ready), then poll
    setTimeout(fetchSessionStatuses, 1500);
    setInterval(fetchSessionStatuses, 10000);

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
