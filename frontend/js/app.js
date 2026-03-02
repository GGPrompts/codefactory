/* ==============================================================
   CodeFactory -- Elevator Logic, Dynamic Floors & Profile Management
   ============================================================== */
(function () {
    'use strict';

    // -- DOM References (static) --
    var indicator = document.getElementById('panelIndicator');
    var arrow = document.getElementById('panelArrow');
    var floorsContainer = document.getElementById('floors-container');
    var elevatorButtons = document.getElementById('elevator-buttons');

    // -- State --
    var profiles = [];       // Array from /api/profiles
    var defaultCwd = '';
    var floorCount = 0;
    var currentFloor = 'lobby';
    var jumpTarget = null;
    var editingFloor = null;  // floor ID currently in edit mode

    // These are rebuilt after floors render
    var floors = [];   // NodeList -> array of section.floor elements
    var buttons = [];  // NodeList -> array of .floor-btn elements
    var floorLabels = {};  // id -> label string
    var floorRank = {};    // id -> numeric rank

    // ==============================================================
    // FETCH PROFILES & RENDER
    // ==============================================================
    fetch('/api/profiles')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            profiles = (data && data.profiles) || [];
            defaultCwd = (data && data.default_cwd) || '';
            renderFloors(profiles);
            initElevatorMechanics();
            setupMobileElevator();
            initLobbyWorkdir();
            reconnectExistingSessions();
            console.log('[CodeFactory] Loaded ' + profiles.length + ' profiles');
        })
        .catch(function(err) {
            console.warn('[CodeFactory] Failed to load profiles:', err);
            // Render empty state
            renderFloors([]);
            initElevatorMechanics();
        });

    // ==============================================================
    // FLOOR RENDERING
    // ==============================================================
    function renderFloors(profileList) {
        // Filter out disabled profiles but keep original IDs
        var enabledProfiles = profileList.filter(function(p) {
            return p.enabled !== false;
        });
        floorCount = enabledProfiles.length;
        var html = '';

        // Build floors top-down (highest number first)
        for (var i = floorCount; i >= 1; i--) {
            var profile = enabledProfiles[i - 1];
            var floorId = profile.id || String(i);

            html += buildFloorHTML(floorId, profile);

            // Shaft wall between floors (and before lobby)
            html += buildShaftWallHTML(floorId, profile.icon);
        }

        // Handle 0 profiles: show add prompt in lobby area
        floorsContainer.innerHTML = html;

        // Update lobby description for 0-profile edge case
        if (floorCount === 0) {
            var lobbyDesc = document.querySelector('.lobby-desc');
            if (lobbyDesc) {
                lobbyDesc.innerHTML =
                    'No terminal profiles configured yet. Add profiles to ' +
                    '<code>~/.config/codefactory/profiles.json</code> and reload.';
            }
            var ascend = document.querySelector('.lobby-ascend');
            if (ascend) ascend.style.display = 'none';
        }

        // Build elevator panel buttons
        renderElevatorButtons(enabledProfiles);

        // Rebuild references
        rebuildDOMReferences(enabledProfiles);

        // Attach floor event listeners (power on/off, edit)
        attachFloorListeners(enabledProfiles);

        // Auto-load page floors
        autoLoadPageFloors(enabledProfiles);
    }

    // ==============================================================
    // PANEL STATE (localStorage)
    // ==============================================================
    function getPanelState(floorId) {
        try {
            return localStorage.getItem('cf-panel-' + floorId) === 'open';
        } catch (e) { return false; }
    }

    function setPanelState(floorId, open) {
        try {
            localStorage.setItem('cf-panel-' + floorId, open ? 'open' : 'closed');
        } catch (e) { /* ignore */ }
    }

    function buildFloorHTML(floorId, profile) {
        var name = profile.name || 'Terminal Bay ' + floorId;
        var icon = profile.icon || '';
        var isPage = !!profile.page;

        if (isPage) {
            return buildPageFloorHTML(floorId, profile, name, icon);
        }
        return buildTerminalFloorHTML(floorId, profile, name, icon);
    }

    function buildTerminalFloorHTML(floorId, profile, name, icon) {
        var command = profile.command || 'bash';
        var cwd = profile.cwd || defaultCwd || '~';
        var hasPanel = !!profile.panel;
        var panelOpen = hasPanel && getPanelState(floorId);

        // Panel toggle button (only when panel is configured)
        var panelToggleBtn = hasPanel
            ? '<button class="power-btn panel-toggle-btn' + (panelOpen ? ' panel-active' : '') + '" data-floor="' + floorId + '" data-panel="' + escapeAttr(profile.panel) + '" title="Toggle side panel">[PANEL]</button>'
            : '';

        // Side panel div (only when panel is configured)
        var sidePanelHTML = hasPanel
            ? '<div class="floor-side-panel' + (panelOpen ? '' : ' collapsed') + '" id="side-panel-' + floorId + '">' +
                  '<div class="panel-resize-handle" data-floor="' + floorId + '"></div>' +
                  '<div class="panel-content" id="panel-content-' + floorId + '"></div>' +
              '</div>'
            : '';

        return '' +
            '<section class="floor powered-off" id="floor-' + floorId + '">' +
                '<div class="elevator-doors">' +
                    '<div class="door door-left"></div>' +
                    '<div class="door door-right"></div>' +
                '</div>' +
                '<div class="floor-frame">' +
                    '<div class="floor-header">' +
                        '<span class="floor-label">' + (icon ? escapeHtml(icon) + ' ' : '') + 'Floor ' + floorId + '</span>' +
                        '<span class="floor-title">' + escapeHtml(name) + '</span>' +
                        panelToggleBtn +
                        '<span class="floor-status" id="status-' + floorId + '">OFFLINE</span>' +
                    '</div>' +
                    '<!-- Offline profile card -->' +
                    '<div class="profile-card" id="profile-card-' + floorId + '">' +
                        '<div class="profile-info">' +
                            '<div class="profile-icon">' + escapeHtml(icon || floorId) + '</div>' +
                            '<div class="profile-details">' +
                                '<div class="profile-name">' + escapeHtml(name) + '</div>' +
                                '<div class="profile-meta">' +
                                    '<span class="profile-command">' + escapeHtml(command) + '</span>' +
                                    '<span class="profile-cwd">' + escapeHtml(cwd) + '</span>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="profile-actions">' +
                            '<button class="power-btn power-on-btn" data-floor="' + floorId + '">[POWER ON]</button>' +
                            '<button class="power-btn edit-btn" data-floor="' + floorId + '">[EDIT]</button>' +
                        '</div>' +
                    '</div>' +
                    '<!-- Edit form (hidden by default) -->' +
                    buildEditFormHTML(floorId, profile) +
                    '<!-- Terminal + optional side panel in flex row -->' +
                    '<div class="floor-content-row" id="content-row-' + floorId + '">' +
                        '<div class="terminal-container" id="terminal-' + floorId + '"></div>' +
                        sidePanelHTML +
                    '</div>' +
                    '<!-- Detach / Kill buttons (shown when powered on) -->' +
                    '<div class="power-off-bar" id="power-off-bar-' + floorId + '">' +
                        '<button class="power-btn detach-btn" data-floor="' + floorId + '">[DETACH]</button>' +
                        '<button class="power-btn kill-btn" data-floor="' + floorId + '">[KILL]</button>' +
                    '</div>' +
                '</div>' +
            '</section>';
    }

    function buildPageFloorHTML(floorId, profile, name, icon) {
        return '' +
            '<section class="floor powered-off" id="floor-' + floorId + '" data-page="' + escapeAttr(profile.page) + '">' +
                '<div class="elevator-doors">' +
                    '<div class="door door-left"></div>' +
                    '<div class="door door-right"></div>' +
                '</div>' +
                '<div class="floor-frame">' +
                    '<div class="floor-header">' +
                        '<span class="floor-label">' + (icon ? escapeHtml(icon) + ' ' : '') + 'Floor ' + floorId + '</span>' +
                        '<span class="floor-title">' + escapeHtml(name) + '</span>' +
                        '<span class="floor-status" id="status-' + floorId + '">OFFLINE</span>' +
                    '</div>' +
                    '<!-- Offline profile card -->' +
                    '<div class="profile-card" id="profile-card-' + floorId + '">' +
                        '<div class="profile-info">' +
                            '<div class="profile-icon">' + escapeHtml(icon || floorId) + '</div>' +
                            '<div class="profile-details">' +
                                '<div class="profile-name">' + escapeHtml(name) + '</div>' +
                                '<div class="profile-meta">' +
                                    '<span class="profile-command">[PAGE] ' + escapeHtml(profile.page) + '</span>' +
                                '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="profile-actions">' +
                            '<button class="power-btn power-on-btn" data-floor="' + floorId + '">[POWER ON]</button>' +
                            '<button class="power-btn edit-btn" data-floor="' + floorId + '">[EDIT]</button>' +
                        '</div>' +
                    '</div>' +
                    '<!-- Edit form (hidden by default) -->' +
                    buildEditFormHTML(floorId, profile) +
                    '<!-- Page container in flex row -->' +
                    '<div class="floor-content-row" id="content-row-' + floorId + '">' +
                        '<div class="page-container" id="page-' + floorId + '"></div>' +
                    '</div>' +
                    '<!-- Power off bar for page floors -->' +
                    '<div class="power-off-bar" id="power-off-bar-' + floorId + '">' +
                        '<button class="power-btn kill-btn" data-floor="' + floorId + '">[POWER OFF]</button>' +
                    '</div>' +
                '</div>' +
            '</section>';
    }

    function buildEditFormHTML(floorId, profile) {
        var name = profile.name || '';
        var command = profile.command || '';
        var cwd = profile.cwd || '';
        var icon = profile.icon || '';

        return '' +
            '<div class="profile-edit-form" id="edit-form-' + floorId + '" style="display:none;">' +
                '<div class="edit-field">' +
                    '<label>NAME</label>' +
                    '<input type="text" class="edit-input" id="edit-name-' + floorId + '" value="' + escapeAttr(name) + '">' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>COMMAND <span class="label-hint">(blank for page floors)</span></label>' +
                    '<input type="text" class="edit-input" id="edit-command-' + floorId + '" value="' + escapeAttr(command) + '">' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>CWD <span class="label-hint">(blank = inherit global)</span></label>' +
                    '<input type="text" class="edit-input" id="edit-cwd-' + floorId + '" value="' + escapeAttr(cwd) + '" placeholder="' + escapeAttr(defaultCwd || '~') + '">' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>ICON</label>' +
                    '<input type="text" class="edit-input edit-input-icon" id="edit-icon-' + floorId + '" value="' + escapeAttr(icon) + '" placeholder="emoji or leave blank">' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>PANEL <span class="label-hint">(markdown filename, e.g. claude.md)</span></label>' +
                    '<input type="text" class="edit-input" id="edit-panel-' + floorId + '" value="' + escapeAttr(profile.panel || '') + '" placeholder="(optional)">' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>PAGE <span class="label-hint">(HTML file path — sets floor as page type)</span></label>' +
                    '<input type="text" class="edit-input" id="edit-page-' + floorId + '" value="' + escapeAttr(profile.page || '') + '" placeholder="(optional)">' +
                '</div>' +
                '<div class="edit-actions">' +
                    '<button class="power-btn save-btn" data-floor="' + floorId + '">[SAVE]</button>' +
                    '<button class="power-btn cancel-btn" data-floor="' + floorId + '">[CANCEL]</button>' +
                '</div>' +
            '</div>';
    }

    function buildShaftWallHTML(floorId, icon) {
        var shaftContent = icon ? escapeHtml(icon) : escapeHtml(floorId);
        return '' +
            '<div class="shaft-wall">' +
                '<div class="caution-stripe"></div>' +
                '<span class="shaft-wall-number">' + shaftContent + '</span>' +
                '<div class="caution-stripe"></div>' +
            '</div>';
    }

    function renderElevatorButtons(profileList) {
        var html = '';
        // Buttons go top-down (highest floor first)
        for (var i = profileList.length; i >= 1; i--) {
            var profile = profileList[i - 1];
            var floorId = profile.id || String(i);
            var name = profile.name || 'Terminal Bay ' + floorId;
            var btnContent = profile.icon ? escapeHtml(profile.icon) : floorId;
            var iconClass = profile.icon ? ' has-icon' : '';
            html += '<button class="floor-btn' + iconClass + '" data-target="floor-' + floorId +
                    '" data-label="' + escapeAttr(name) + '">' + btnContent + '</button>';
        }
        elevatorButtons.innerHTML = html;
    }

    function rebuildDOMReferences(profileList) {
        floors = Array.prototype.slice.call(document.querySelectorAll('section.floor'));
        buttons = Array.prototype.slice.call(document.querySelectorAll('.floor-btn'));

        // Rebuild label and rank maps
        floorLabels = { 'lobby': 'L' };
        floorRank = { 'lobby': 0 };

        for (var i = 0; i < profileList.length; i++) {
            var floorId = profileList[i].id || String(i + 1);
            floorLabels['floor-' + floorId] = floorId;
            floorRank['floor-' + floorId] = i + 1;
        }
    }

    // ==============================================================
    // FLOOR EVENT LISTENERS
    // ==============================================================
    function attachFloorListeners(profileList) {
        // Power ON buttons
        document.querySelectorAll('.power-on-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                var profile = findProfile(floorId);
                if (profile) {
                    if (profile.page) {
                        powerOnPage(floorId, profile);
                    } else {
                        // Resolve cwd: use profile's explicit cwd, or fall back to default
                        var resolved = Object.assign({}, profile, {
                            cwd: profile.cwd || defaultCwd || null
                        });
                        CodeFactoryTerminals.powerOn(floorId, resolved);
                        // Focus terminal after it connects
                        setTimeout(function() { CodeFactoryTerminals.focus(floorId); }, 200);
                        // If panel is configured and was open, load its content
                        if (profile.panel && getPanelState(floorId)) {
                            var content = document.getElementById('panel-content-' + floorId);
                            if (content && !content.hasChildNodes()) {
                                MarkdownPanel.load(content, profile.panel);
                            }
                        }
                    }
                }
            });
        });

        // Detach buttons (disconnect PTY, preserve tmux session)
        document.querySelectorAll('.detach-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                CodeFactoryTerminals.detach(floorId);
            });
        });

        // Kill buttons (disconnect PTY and destroy tmux session, or power off page)
        document.querySelectorAll('.kill-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                var profile = findProfile(floorId);
                if (profile && profile.page) {
                    powerOffPage(floorId);
                } else {
                    CodeFactoryTerminals.kill(floorId);
                }
            });
        });

        // Edit buttons
        document.querySelectorAll('.edit-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                enterEditMode(floorId);
            });
        });

        // Save buttons
        document.querySelectorAll('.save-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                saveProfile(floorId);
            });
        });

        // Cancel buttons
        document.querySelectorAll('.cancel-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                exitEditMode(floorId);
            });
        });

        // Panel toggle buttons
        document.querySelectorAll('.panel-toggle-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                var panelName = btn.dataset.panel;
                togglePanel(floorId, panelName, btn);
            });
        });

        // Panel resize handles
        document.querySelectorAll('.panel-resize-handle').forEach(function(handle) {
            initPanelResize(handle);
        });

        // Click-to-focus on terminal containers
        document.querySelectorAll('.terminal-container').forEach(function(container) {
            container.addEventListener('mousedown', function() {
                var floorId = container.id.replace('terminal-', '');
                CodeFactoryTerminals.focus(floorId);
            });
        });
    }

    // ==============================================================
    // PANEL TOGGLE & RESIZE
    // ==============================================================
    function togglePanel(floorId, panelName, btn) {
        var panel = document.getElementById('side-panel-' + floorId);
        if (!panel) return;

        var isCollapsed = panel.classList.contains('collapsed');

        if (isCollapsed) {
            // Expand panel
            panel.classList.remove('collapsed');
            btn.classList.add('panel-active');
            setPanelState(floorId, true);

            // Load content if not yet loaded
            var content = document.getElementById('panel-content-' + floorId);
            if (content && !content.hasChildNodes()) {
                MarkdownPanel.load(content, panelName);
            }
        } else {
            // Collapse panel
            panel.classList.add('collapsed');
            btn.classList.remove('panel-active');
            setPanelState(floorId, false);
        }

        // Refit terminal after panel toggle
        refitTerminal(floorId);
    }

    function refitTerminal(floorId) {
        setTimeout(function () {
            if (typeof CodeFactoryTerminals === 'undefined') return;
            var entry = CodeFactoryTerminals.getTerminal(floorId);
            if (entry && entry.fitAddon && entry.powered) {
                entry.fitAddon.fit();
            }
        }, 350);  // wait for CSS transition
    }

    function initPanelResize(handle) {
        var floorId = handle.dataset.floor;
        var panel = document.getElementById('side-panel-' + floorId);
        if (!panel) return;

        var startX, startWidth;

        handle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', onStop);
            handle.classList.add('dragging');
        });

        function onDrag(e) {
            // Dragging left edge of panel: moving left = wider, moving right = narrower
            var delta = startX - e.clientX;
            var newWidth = Math.max(200, Math.min(800, startWidth + delta));
            panel.style.width = newWidth + 'px';
        }

        function onStop() {
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', onStop);
            handle.classList.remove('dragging');
            refitTerminal(floorId);
        }
    }

    // ==============================================================
    // PAGE FLOOR POWER ON / OFF
    // ==============================================================
    function powerOnPage(floorId, profile) {
        var container = document.getElementById('page-' + floorId);
        if (!container) return;

        // Create iframe
        var iframe = document.createElement('iframe');
        iframe.className = 'page-iframe';
        iframe.src = /^https?:\/\//.test(profile.page)
            ? profile.page
            : '/api/pages/' + encodeURIComponent(profile.page);
        container.innerHTML = '';
        container.appendChild(iframe);

        // Set floor to powered-on state
        var section = document.getElementById('floor-' + floorId);
        if (section) {
            section.classList.remove('powered-off');
            section.classList.add('powered-on');
        }
        var statusEl = document.getElementById('status-' + floorId);
        if (statusEl) {
            statusEl.textContent = 'ONLINE';
            statusEl.className = 'floor-status online';
        }
        console.log('[CodeFactory] Page floor ' + floorId + ' powered on: ' + profile.page);
    }

    function powerOffPage(floorId) {
        var container = document.getElementById('page-' + floorId);
        if (container) {
            container.innerHTML = '';
        }

        // Set floor to powered-off state
        var section = document.getElementById('floor-' + floorId);
        if (section) {
            section.classList.remove('powered-on');
            section.classList.add('powered-off');
        }
        var statusEl = document.getElementById('status-' + floorId);
        if (statusEl) {
            statusEl.textContent = 'OFFLINE';
            statusEl.className = 'floor-status offline';
        }
        console.log('[CodeFactory] Page floor ' + floorId + ' powered off');
    }

    function autoLoadPageFloors(profileList) {
        profileList.forEach(function(profile) {
            if (profile.page) {
                var floorId = profile.id;
                powerOnPage(floorId, profile);
            }
        });
    }

    function findProfile(floorId) {
        for (var i = 0; i < profiles.length; i++) {
            if (profiles[i].id === floorId || String(i + 1) === floorId) {
                return profiles[i];
            }
        }
        return null;
    }

    function findProfileIndex(floorId) {
        for (var i = 0; i < profiles.length; i++) {
            if (profiles[i].id === floorId || String(i + 1) === floorId) {
                return i;
            }
        }
        return -1;
    }

    // ==============================================================
    // PER-FLOOR SWIPE PANELS
    // ==============================================================
    var PANEL_EDGES = ['left', 'right', 'top', 'bottom'];
    var activeFloorPanelEdges = []; // edges currently claimed by floor config

    /**
     * Resolve a panel identifier to a URL.
     * - Full URLs (http:/https:) pass through unchanged.
     * - Absolute or ~-prefixed paths pass through unchanged.
     * - Bare names map to /api/pages/{name}.html
     */
    function resolvePanelUrl(identifier) {
        if (/^https?:\/\//.test(identifier)) return identifier;
        if (identifier.charAt(0) === '/' || identifier.charAt(0) === '~') return identifier;
        // Bare name -> page endpoint; append .html if no extension
        var name = identifier;
        if (name.indexOf('.') === -1) name = name + '.html';
        return '/api/pages/' + encodeURIComponent(name);
    }

    /**
     * Build an iframe element for a swipe panel.
     */
    function buildPanelIframe(url) {
        var iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.className = 'swipe-panel-iframe';
        iframe.setAttribute('frameborder', '0');
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        return iframe;
    }

    /**
     * Clear all per-floor swipe panel registrations.
     * Does not touch edges that were not claimed by floor config.
     */
    function clearFloorPanels() {
        activeFloorPanelEdges.forEach(function (edge) {
            SwipePanels.unregisterPanel(edge);
        });
        activeFloorPanelEdges = [];
    }

    /**
     * Apply swipe panel config for the given floor.
     * On mobile: loads the floor's markdown panel into the left swipe edge.
     * Also handles profile.panels (map of edge -> identifier) for iframe panels.
     */
    function applyFloorPanels(floorId) {
        clearFloorPanels();

        var profile = findProfile(floorId);
        if (!profile) return;

        // On mobile, route the markdown side panel to the left swipe edge
        var isMobile = mobileMediaQuery.matches;
        if (isMobile && profile.panel) {
            var wrapper = document.createElement('div');
            wrapper.className = 'swipe-markdown-panel';
            var header = document.createElement('div');
            header.className = 'swipe-markdown-header';
            header.textContent = 'REFERENCE';
            wrapper.appendChild(header);
            var content = document.createElement('div');
            content.className = 'swipe-markdown-content industrial-prose';
            wrapper.appendChild(content);
            SwipePanels.registerPanel('left', wrapper);
            activeFloorPanelEdges.push('left');
            MarkdownPanel.load(content, profile.panel);
        }

        // Apply profile.panels config (iframe-based panels)
        if (profile.panels) {
            var panelConfig = profile.panels;
            PANEL_EDGES.forEach(function (edge) {
                if (panelConfig[edge] && activeFloorPanelEdges.indexOf(edge) === -1) {
                    var url = resolvePanelUrl(panelConfig[edge]);
                    var iframe = buildPanelIframe(url);
                    SwipePanels.registerPanel(edge, iframe);
                    activeFloorPanelEdges.push(edge);
                }
            });
        }
    }

    // ==============================================================
    // EDIT MODE
    // ==============================================================
    function enterEditMode(floorId) {
        editingFloor = floorId;
        var card = document.getElementById('profile-card-' + floorId);
        var form = document.getElementById('edit-form-' + floorId);
        if (card) card.style.display = 'none';
        if (form) form.style.display = 'flex';

        // Focus the name input
        var nameInput = document.getElementById('edit-name-' + floorId);
        if (nameInput) {
            setTimeout(function() { nameInput.focus(); nameInput.select(); }, 50);
        }
    }

    function exitEditMode(floorId) {
        editingFloor = null;
        var card = document.getElementById('profile-card-' + floorId);
        var form = document.getElementById('edit-form-' + floorId);
        if (card) card.style.display = '';
        if (form) form.style.display = 'none';

        // Reset form values to current profile
        var profile = findProfile(floorId);
        if (profile) {
            var nameInput = document.getElementById('edit-name-' + floorId);
            var cmdInput = document.getElementById('edit-command-' + floorId);
            var cwdInput = document.getElementById('edit-cwd-' + floorId);
            var iconInput = document.getElementById('edit-icon-' + floorId);
            var panelInput = document.getElementById('edit-panel-' + floorId);
            var pageInput = document.getElementById('edit-page-' + floorId);
            if (nameInput) nameInput.value = profile.name || '';
            if (cmdInput) cmdInput.value = profile.command || '';
            if (cwdInput) cwdInput.value = profile.cwd || defaultCwd || '';
            if (iconInput) iconInput.value = profile.icon || '';
            if (panelInput) panelInput.value = profile.panel || '';
            if (pageInput) pageInput.value = profile.page || '';
        }
    }

    function saveProfile(floorId) {
        var idx = findProfileIndex(floorId);
        if (idx === -1) return;

        var nameInput = document.getElementById('edit-name-' + floorId);
        var cmdInput = document.getElementById('edit-command-' + floorId);
        var cwdInput = document.getElementById('edit-cwd-' + floorId);
        var iconInput = document.getElementById('edit-icon-' + floorId);
        var panelInput = document.getElementById('edit-panel-' + floorId);
        var pageInput = document.getElementById('edit-page-' + floorId);

        var newName = nameInput ? nameInput.value.trim() : '';
        var newCommand = cmdInput ? cmdInput.value.trim() : '';
        var newCwd = cwdInput ? cwdInput.value.trim() : '';
        var newIcon = iconInput ? iconInput.value.trim() : '';
        var newPanel = panelInput ? panelInput.value.trim() : '';
        var newPage = pageInput ? pageInput.value.trim() : '';

        if (!newName) {
            nameInput.classList.add('input-error');
            setTimeout(function() { nameInput.classList.remove('input-error'); }, 1000);
            return;
        }

        // Build the full config to PUT
        var updatedProfiles = profiles.map(function(p, i) {
            if (i === idx) {
                return {
                    name: newName,
                    command: newCommand || null,
                    cwd: (newCwd && newCwd !== defaultCwd) ? newCwd : null,
                    icon: newIcon || null,
                    panel: newPanel || null,
                    page: newPage || null,
                    enabled: p.enabled !== false,
                };
            }
            return {
                name: p.name,
                command: p.command || null,
                cwd: (p.cwd && p.cwd !== defaultCwd) ? p.cwd : null,
                icon: p.icon || null,
                panel: p.panel || null,
                page: p.page || null,
                enabled: p.enabled !== false,
            };
        });

        var body = JSON.stringify({
            default_cwd: defaultCwd,
            profiles: updatedProfiles,
        });

        // Show saving state
        var saveBtn = document.querySelector('.save-btn[data-floor="' + floorId + '"]');
        if (saveBtn) saveBtn.textContent = '[SAVING...]';

        fetch('/api/profiles', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: body,
        })
        .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function() {
            // Update local state (preserve null for cwd that matches default)
            profiles[idx].name = newName;
            profiles[idx].command = newCommand || null;
            profiles[idx].cwd = (newCwd && newCwd !== defaultCwd) ? newCwd : null;
            profiles[idx].icon = newIcon || null;
            profiles[idx].panel = newPanel || null;
            profiles[idx].page = newPage || null;

            // Update the UI elements
            var floorSection = document.getElementById('floor-' + floorId);
            if (floorSection) {
                var titleEl = floorSection.querySelector('.floor-title');
                if (titleEl) titleEl.textContent = newName;
                var profileNameEl = floorSection.querySelector('.profile-name');
                if (profileNameEl) profileNameEl.textContent = newName;
                var cmdEl = floorSection.querySelector('.profile-command');
                if (cmdEl) cmdEl.textContent = newCommand || 'bash';
                var cwdEl = floorSection.querySelector('.profile-cwd');
                if (cwdEl) cwdEl.textContent = newCwd || defaultCwd;
                var iconEl = floorSection.querySelector('.profile-icon');
                if (iconEl) iconEl.textContent = newIcon || floorId;
            }

            // Update elevator button content and label
            var btn = document.querySelector('.floor-btn[data-target="floor-' + floorId + '"]');
            if (btn) {
                btn.setAttribute('data-label', newName);
                btn.textContent = newIcon || floorId;
                if (newIcon) {
                    btn.classList.add('has-icon');
                } else {
                    btn.classList.remove('has-icon');
                }
            }

            exitEditMode(floorId);
            console.log('[CodeFactory] Profile ' + floorId + ' updated: ' + newName);
        })
        .catch(function(err) {
            console.error('[CodeFactory] Failed to save profile:', err);
            if (saveBtn) saveBtn.textContent = '[ERROR]';
            setTimeout(function() {
                if (saveBtn) saveBtn.textContent = '[SAVE]';
            }, 2000);
        });
    }

    // ==============================================================
    // AUTO-RECONNECT EXISTING SESSIONS
    // ==============================================================
    function reconnectExistingSessions() {
        // Wait for terminal.js to finish fetching existing sessions
        var existing = CodeFactoryTerminals.getExistingSessions();
        var ids = Object.keys(existing);

        if (ids.length > 0) {
            // Sessions already fetched, reconnect now
            doReconnect(ids);
        } else {
            // terminal.js fetch may still be in flight — poll briefly
            var attempts = 0;
            var poll = setInterval(function() {
                attempts++;
                var ex = CodeFactoryTerminals.getExistingSessions();
                var exIds = Object.keys(ex);
                if (exIds.length > 0 || attempts >= 10) {
                    clearInterval(poll);
                    if (exIds.length > 0) doReconnect(exIds);
                }
            }, 200);
        }
    }

    function doReconnect(sessionIds) {
        console.log('[CodeFactory] Auto-reconnecting floors:', sessionIds);
        sessionIds.forEach(function(floorId) {
            var profile = findProfile(floorId);
            if (profile && !profile.page) {
                var resolved = Object.assign({}, profile, {
                    cwd: profile.cwd || defaultCwd || null
                });
                CodeFactoryTerminals.powerOn(floorId, resolved);

                // If panel was open, load it
                if (profile.panel && getPanelState(floorId)) {
                    var content = document.getElementById('panel-content-' + floorId);
                    if (content && !content.hasChildNodes()) {
                        MarkdownPanel.load(content, profile.panel);
                    }
                }
            }
        });
    }

    // ==============================================================
    // RECENT WORKING DIRECTORIES (localStorage)
    // ==============================================================
    var RECENT_DIRS_KEY = 'cf-recent-dirs';
    var RECENT_DIRS_MAX = 10;

    function getRecentDirs() {
        try {
            var raw = localStorage.getItem(RECENT_DIRS_KEY);
            if (!raw) return [];
            var dirs = JSON.parse(raw);
            return Array.isArray(dirs) ? dirs.slice(0, RECENT_DIRS_MAX) : [];
        } catch (e) { return []; }
    }

    function addRecentDir(path) {
        if (!path) return;
        var dirs = getRecentDirs().filter(function(d) { return d !== path; });
        dirs.unshift(path);
        if (dirs.length > RECENT_DIRS_MAX) dirs = dirs.slice(0, RECENT_DIRS_MAX);
        try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs)); } catch (e) { /* ignore */ }
    }

    function removeRecentDir(path) {
        var dirs = getRecentDirs().filter(function(d) { return d !== path; });
        try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs)); } catch (e) { /* ignore */ }
    }

    // ==============================================================
    // LOBBY WORKING DIRECTORY
    // ==============================================================
    function initLobbyWorkdir() {
        var pathEl = document.getElementById('workdir-path');
        var displayEl = document.getElementById('workdir-display');
        var editorEl = document.getElementById('workdir-editor');
        var inputEl = document.getElementById('workdir-input');
        var editBtn = document.getElementById('workdir-edit-btn');
        var saveBtn = document.getElementById('workdir-save-btn');
        var cancelBtn = document.getElementById('workdir-cancel-btn');
        var recentEl = document.getElementById('workdir-recent');

        if (!pathEl) return;

        // Show current value
        pathEl.textContent = defaultCwd || '~';

        // Seed the current defaultCwd into recent dirs
        if (defaultCwd) addRecentDir(defaultCwd);

        function renderRecentDirs() {
            if (!recentEl) return;
            var dirs = getRecentDirs();
            if (dirs.length === 0) {
                recentEl.innerHTML = '';
                recentEl.classList.remove('has-items');
                return;
            }
            var html = '';
            for (var i = 0; i < dirs.length; i++) {
                html += '<div class="workdir-recent-item" data-path="' + escapeAttr(dirs[i]) + '">' +
                    '<span class="workdir-recent-path">' + escapeHtml(dirs[i]) + '</span>' +
                    '<button class="workdir-recent-remove" data-path="' + escapeAttr(dirs[i]) + '" title="Remove">[X]</button>' +
                    '</div>';
            }
            recentEl.innerHTML = html;
            recentEl.classList.add('has-items');

            // Attach click handlers
            recentEl.querySelectorAll('.workdir-recent-item').forEach(function(item) {
                item.addEventListener('click', function(e) {
                    // Ignore if clicking the remove button
                    if (e.target.classList.contains('workdir-recent-remove')) return;
                    var path = item.dataset.path;
                    inputEl.value = path;
                    saveWorkdir();
                });
            });

            recentEl.querySelectorAll('.workdir-recent-remove').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    removeRecentDir(btn.dataset.path);
                    renderRecentDirs();
                });
            });
        }

        function enterWorkdirEdit() {
            inputEl.value = defaultCwd || '';
            displayEl.style.display = 'none';
            editorEl.style.display = '';
            renderRecentDirs();
            setTimeout(function() { inputEl.focus(); inputEl.select(); }, 50);
        }

        function exitWorkdirEdit() {
            editorEl.style.display = 'none';
            displayEl.style.display = '';
            if (recentEl) recentEl.classList.remove('has-items');
        }

        function saveWorkdir() {
            var newCwd = inputEl.value.trim();
            if (!newCwd) return;

            saveBtn.textContent = '[SAVING...]';

            // Build profiles payload preserving null cwd for project-dependent floors
            var updatedProfiles = profiles.map(function(p) {
                return {
                    name: p.name,
                    command: p.command || null,
                    cwd: p.cwd || null,
                    icon: p.icon || null,
                    panel: p.panel || null,
                    page: p.page || null,
                    enabled: p.enabled !== false,
                };
            });

            fetch('/api/profiles', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    default_cwd: newCwd,
                    profiles: updatedProfiles,
                }),
            })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function() {
                defaultCwd = newCwd;
                pathEl.textContent = newCwd;
                addRecentDir(newCwd);

                // Update displayed cwd for floors that inherit default
                profiles.forEach(function(p) {
                    var floorId = p.id;
                    if (!p.cwd) {
                        var cwdEl = document.querySelector('#floor-' + floorId + ' .profile-cwd');
                        if (cwdEl) cwdEl.textContent = newCwd;
                        var cwdInput = document.getElementById('edit-cwd-' + floorId);
                        if (cwdInput && cwdInput.value === '') cwdInput.value = '';
                    }
                });

                exitWorkdirEdit();
                console.log('[CodeFactory] Working directory updated: ' + newCwd);
            })
            .catch(function(err) {
                console.error('[CodeFactory] Failed to save working directory:', err);
                saveBtn.textContent = '[ERROR]';
                setTimeout(function() { saveBtn.textContent = '[SAVE]'; }, 2000);
            });
        }

        editBtn.addEventListener('click', enterWorkdirEdit);
        cancelBtn.addEventListener('click', exitWorkdirEdit);
        saveBtn.addEventListener('click', saveWorkdir);

        inputEl.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') saveWorkdir();
            if (e.key === 'Escape') exitWorkdirEdit();
        });
    }

    // ==============================================================
    // ELEVATOR SOUNDS (Web Audio API)
    // ==============================================================
    var audioCtx = null;
    var audioUnlocked = false;
    var sfxVolume = 0.18;

    function ensureAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    function playDing() {
        // Industrial clunk: short filtered noise burst (like a heavy relay engaging)
        if (!audioUnlocked) return;
        ensureAudio();
        var now = audioCtx.currentTime;
        var bufferSize = audioCtx.sampleRate * 0.08;
        var buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        var data = buffer.getChannelData(0);
        for (var i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
        }
        var noise = audioCtx.createBufferSource();
        noise.buffer = buffer;

        var filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 220;
        filter.Q.value = 3;

        var gain = audioCtx.createGain();
        gain.gain.setValueAtTime(sfxVolume * 0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        noise.start(now);
        noise.stop(now + 0.08);
    }

    function playClick() {
        // Subtle relay tick: tiny noise pop
        if (!audioUnlocked) return;
        ensureAudio();
        var now = audioCtx.currentTime;
        var bufferSize = audioCtx.sampleRate * 0.02;
        var buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        var data = buffer.getChannelData(0);
        for (var i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.08));
        }
        var noise = audioCtx.createBufferSource();
        noise.buffer = buffer;

        var filter = audioCtx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 800;

        var gain = audioCtx.createGain();
        gain.gain.setValueAtTime(sfxVolume * 0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        noise.start(now);
        noise.stop(now + 0.02);
    }

    function unlockAudio() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        ensureAudio();
    }
    document.addEventListener('click', unlockAudio, { once: false });
    document.addEventListener('touchstart', unlockAudio, { once: false });
    document.addEventListener('keydown', unlockAudio, { once: false });

    // ==============================================================
    // MOBILE ELEVATOR SWIPE PANEL
    // ==============================================================
    var mobileElevatorRegistered = false;
    var mobileMediaQuery = window.matchMedia('(max-width: 768px)');

    /**
     * Build a compact elevator panel for the right-edge swipe panel on mobile.
     * Mirrors the desktop elevator buttons with just emoji/number icons.
     */
    function setupMobileElevator() {
        var isMobile = mobileMediaQuery.matches;

        // Don't register mobile elevator if a floor panel claims the right edge
        var rightClaimedByFloor = activeFloorPanelEdges.indexOf('right') !== -1;

        if (isMobile && !mobileElevatorRegistered && floorCount > 0 && !rightClaimedByFloor) {
            var wrapper = document.createElement('div');
            wrapper.className = 'mobile-elevator';

            // Header
            var header = document.createElement('div');
            header.className = 'mobile-elevator-header';
            header.textContent = 'FLOORS';
            wrapper.appendChild(header);

            // Indicator showing current floor
            var ind = document.createElement('div');
            ind.className = 'mobile-elevator-indicator';
            ind.id = 'mobileElevatorIndicator';
            ind.textContent = floorLabels[currentFloor] || 'L';
            wrapper.appendChild(ind);

            // Floor buttons (highest first, matching desktop order)
            var btnContainer = document.createElement('div');
            btnContainer.className = 'mobile-elevator-buttons';

            // Query the desktop buttons to mirror them
            var desktopBtns = elevatorButtons.querySelectorAll('.floor-btn');
            for (var i = 0; i < desktopBtns.length; i++) {
                var srcBtn = desktopBtns[i];
                var btn = document.createElement('button');
                btn.className = 'mobile-floor-btn' + (srcBtn.classList.contains('has-icon') ? ' has-icon' : '');
                btn.setAttribute('data-target', srcBtn.dataset.target);
                btn.setAttribute('data-label', srcBtn.dataset.label);
                btn.innerHTML = srcBtn.innerHTML;
                if (srcBtn.dataset.target === currentFloor) {
                    btn.classList.add('active');
                }
                btnContainer.appendChild(btn);
            }

            // Lobby button
            var lobbyBtn = document.createElement('button');
            lobbyBtn.className = 'mobile-floor-btn';
            lobbyBtn.setAttribute('data-target', 'lobby');
            lobbyBtn.setAttribute('data-label', 'Lobby');
            lobbyBtn.textContent = 'L';
            if (currentFloor === 'lobby') {
                lobbyBtn.classList.add('active');
            }
            btnContainer.appendChild(lobbyBtn);

            wrapper.appendChild(btnContainer);

            // Attach click handlers to all mobile buttons
            var mobileBtns = btnContainer.querySelectorAll('.mobile-floor-btn');
            for (var j = 0; j < mobileBtns.length; j++) {
                mobileBtns[j].addEventListener('click', (function(mbtn) {
                    return function() {
                        playClick();
                        var targetId = mbtn.dataset.target;
                        var target = document.getElementById(targetId);
                        if (target) {
                            jumpTarget = targetId;
                            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                        // Auto-close swipe panel after selection
                        SwipePanels.hidePanel('right');
                    };
                })(mobileBtns[j]));
            }

            SwipePanels.registerPanel('right', wrapper);
            mobileElevatorRegistered = true;
        } else if (!isMobile && mobileElevatorRegistered) {
            SwipePanels.unregisterPanel('right');
            mobileElevatorRegistered = false;
        }
    }

    /**
     * Sync the mobile elevator buttons' active state with the current floor.
     */
    function syncMobileElevator() {
        if (!mobileElevatorRegistered) return;
        var panel = SwipePanels.getPanelElement('right');
        if (!panel) return;
        var mobileBtns = panel.querySelectorAll('.mobile-floor-btn');
        for (var i = 0; i < mobileBtns.length; i++) {
            mobileBtns[i].classList.toggle('active', mobileBtns[i].dataset.target === currentFloor);
        }
        var mInd = document.getElementById('mobileElevatorIndicator');
        if (mInd) {
            mInd.textContent = floorLabels[currentFloor] || '?';
        }
    }

    // Listen for viewport changes to register/unregister
    mobileMediaQuery.addEventListener('change', function() {
        setupMobileElevator();
    });

    // ==============================================================
    // ELEVATOR MECHANICS (initialized after floors render)
    // ==============================================================
    function initElevatorMechanics() {
        // Scroll to bottom on load (start at lobby)
        var htmlEl = document.documentElement;
        htmlEl.style.scrollBehavior = 'auto';
        window.scrollTo(0, document.body.scrollHeight);
        requestAnimationFrame(function () {
            htmlEl.style.scrollBehavior = 'smooth';
        });

        // Intersection observer for entrance animations
        var viewObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in-view');
                }
            });
        }, { threshold: 0.2 });

        floors.forEach(function (floor) {
            viewObserver.observe(floor);
        });

        // Scroll handler for door animations + active floor
        var ticking = false;
        window.addEventListener('scroll', function () {
            if (!ticking) {
                requestAnimationFrame(updateActiveFloor);
                ticking = true;
            }
        });

        function updateActiveFloor() {
            ticking = false;
            var bestFloor = null;
            var bestVisibility = -1;
            var vh = window.innerHeight;

            floors.forEach(function (floor) {
                var rect = floor.getBoundingClientRect();
                var top = Math.max(0, rect.top);
                var bottom = Math.min(vh, rect.bottom);
                var visible = Math.max(0, bottom - top);
                if (visible > bestVisibility) {
                    bestVisibility = visible;
                    bestFloor = floor.id;
                }

                // Door animation
                var floorCenter = rect.top + rect.height / 2;
                var vpCenter = vh / 2;
                var dist = Math.abs(floorCenter - vpCenter) / vh;
                var openness = Math.max(0, Math.min(1, (0.9 - dist) / 0.65));
                openness = openness * openness * (3 - 2 * openness);
                if (jumpTarget && floor.id !== jumpTarget) {
                    openness = 0;
                }
                floor.style.setProperty('--door-open', openness);
            });

            if (bestFloor && bestFloor !== currentFloor) {
                var prevRank = floorRank[currentFloor] || 0;
                var newRank = floorRank[bestFloor] || 0;

                currentFloor = bestFloor;
                var wasJump = !!jumpTarget;
                var arrived = !jumpTarget || bestFloor === jumpTarget;
                if (arrived && jumpTarget) {
                    jumpTarget = null;
                }
                indicator.textContent = floorLabels[bestFloor] || '?';

                // Apply per-floor swipe panels for the new floor
                applyFloorPanels(bestFloor.replace('floor-', ''));

                // Re-register mobile elevator if needed (floor panels may have claimed right edge)
                setupMobileElevator();

                if (arrived) {
                    playDing();
                    // Focus terminal only on explicit jump (button/keyboard), not manual scroll
                    if (wasJump) {
                        var floorNum = bestFloor.replace('floor-', '');
                        if (floorNum !== 'lobby') {
                            CodeFactoryTerminals.focus(floorNum);
                        }
                    }
                }

                indicator.classList.add('flash');
                setTimeout(function () {
                    indicator.classList.remove('flash');
                }, 300);

                if (newRank > prevRank) {
                    arrow.innerHTML = '&#9650;';
                } else {
                    arrow.innerHTML = '&#9660;';
                }

                buttons.forEach(function (btn) {
                    btn.classList.toggle('active', btn.dataset.target === bestFloor);
                });

                // Sync mobile elevator panel if active
                syncMobileElevator();
            }
        }

        // Button clicks (smooth scroll to target floor)
        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                playClick();
                var targetId = btn.dataset.target;
                var target = document.getElementById(targetId);
                if (target) {
                    jumpTarget = targetId;
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

        // Keyboard navigation (1-9 adapts to floor count, L for lobby)
        document.addEventListener('keydown', function (e) {
            // Ignore if user is typing in an input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            // Escape exits edit mode
            if (e.key === 'Escape' && editingFloor) {
                exitEditMode(editingFloor);
                return;
            }

            var targetId = null;
            if (e.key === 'l' || e.key === 'L') {
                targetId = 'lobby';
            } else {
                var num = parseInt(e.key, 10);
                if (num >= 1 && num <= floorCount && num <= 9) {
                    targetId = 'floor-' + num;
                }
            }

            if (targetId) {
                playClick();
                var target = document.getElementById(targetId);
                if (target) {
                    jumpTarget = targetId;
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
        });

        // Refit all powered-on terminals
        function refitAllTerminals() {
            if (typeof CodeFactoryTerminals === 'undefined') return;
            for (var i = 1; i <= floorCount; i++) {
                var entry = CodeFactoryTerminals.getTerminal(String(i));
                if (entry && entry.fitAddon && entry.powered) {
                    entry.fitAddon.fit();
                }
            }
        }

        // Window resize: refit all powered-on terminals
        var resizeTick = null;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTick);
            resizeTick = setTimeout(refitAllTerminals, 200);
        });

        // visualViewport API: track soft keyboard on mobile.
        // Updates --vvh CSS custom property so terminal containers resize.
        if (window.visualViewport) {
            var vvTick = null;
            function updateVisualViewport() {
                var vh = window.visualViewport.height;
                document.documentElement.style.setProperty('--vvh', vh + 'px');
                clearTimeout(vvTick);
                vvTick = setTimeout(refitAllTerminals, 150);
            }
            window.visualViewport.addEventListener('resize', updateVisualViewport);
            // Set initial value
            updateVisualViewport();
        }

        // Initial state
        updateActiveFloor();
    }

    // ==============================================================
    // UTILITY
    // ==============================================================
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

})();
