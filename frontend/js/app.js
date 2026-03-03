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
    var viewObserver = null; // IntersectionObserver, created in initElevatorMechanics

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
            setupMobileBar();
            initLobbyWorkdir();
            initLobbySettings();
            initLobbyRefresh();
            initLobbyShutdown();
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

        // Re-observe new floor elements for entrance animations
        if (viewObserver) {
            floors.forEach(function(floor) {
                viewObserver.observe(floor);
            });
        }

        // Attach floor event listeners (power on/off, edit)
        attachFloorListeners(enabledProfiles);

        // Rebuild mobile bottom bar to reflect new floors
        if (mobileBar) {
            mobileBar.remove();
            mobileBar = null;
            mobileBarTrack = null;
            mobileBarDots = null;
        }
        setupMobileBar();

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

    function getPanelWidth(floorId) {
        try {
            var w = parseInt(localStorage.getItem('cf-panel-width-' + floorId), 10);
            return w > 0 ? w : 0;
        } catch (e) { return 0; }
    }

    function setPanelWidth(floorId, width) {
        try {
            localStorage.setItem('cf-panel-width-' + floorId, String(width));
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

        // Eye button for terminal text view (always present on terminal floors)
        var eyeBtn = '<button class="power-btn term-view-btn" data-floor="' + floorId + '" title="View terminal text">' +
            '<svg class="term-view-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
                '<circle cx="12" cy="12" r="3"/>' +
            '</svg>' +
        '</button>';

        // Side panel div (always present for terminal floors -- used by .md panel and/or terminal text view)
        var savedWidth = getPanelWidth(floorId);
        var widthStyle = (panelOpen && savedWidth) ? ' style="width:' + savedWidth + 'px"' : '';
        var sidePanelHTML =
            '<div class="floor-side-panel' + (panelOpen ? '' : ' collapsed') + '" id="side-panel-' + floorId + '"' + widthStyle + '>' +
                '<div class="panel-resize-handle" data-floor="' + floorId + '"></div>' +
                (hasPanel
                    ? '<div class="panel-tabs" id="panel-tabs-' + floorId + '">' +
                          '<button class="panel-tab panel-tab-active" data-floor="' + floorId + '" data-tab="reference">REFERENCE</button>' +
                          '<button class="panel-tab" data-floor="' + floorId + '" data-tab="terminal">TERMINAL</button>' +
                      '</div>'
                    : '') +
                '<div class="panel-content" id="panel-content-' + floorId + '"></div>' +
            '</div>';

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
                        eyeBtn +
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
                    '<!-- Terminal + side panel in flex row -->' +
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
                        '<div class="page-nav-btns">' +
                            '<button class="power-btn page-nav-btn" data-floor="' + floorId + '" data-nav="back" title="Back">[&#9664;]</button>' +
                            '<button class="power-btn page-nav-btn" data-floor="' + floorId + '" data-nav="forward" title="Forward">[&#9654;]</button>' +
                            '<button class="power-btn page-nav-btn" data-floor="' + floorId + '" data-nav="refresh" title="Refresh">[&#8635;]</button>' +
                            '<button class="power-btn page-nav-btn" data-floor="' + floorId + '" data-nav="home" title="Home">[&#8962;]</button>' +
                        '</div>' +
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
                    '<input type="text" class="edit-input edit-input-icon" id="edit-icon-' + floorId + '" value="' + escapeAttr(icon) + '" placeholder="emoji">' +
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
            var pageClass = profile.page ? ' floor-btn-page' : '';
            html += '<button class="floor-btn' + iconClass + pageClass + '" data-target="floor-' + floorId +
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
            floorLabels['floor-' + floorId] = String(i + 1);
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
                        // Lock scroll position during power-on to prevent camera jump
                        var section = document.getElementById('floor-' + floorId);
                        var scrollY = window.scrollY;
                        CodeFactoryTerminals.powerOn(floorId, resolved);
                        // Restore scroll position after DOM reflow
                        requestAnimationFrame(function() {
                            window.scrollTo(0, scrollY);
                        });
                        // Focus terminal after it connects
                        setTimeout(function() {
                            CodeFactoryTerminals.focus(floorId);
                            syncMobileBar();
                        }, 200);
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
                syncMobileBar();
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
                syncMobileBar();
            });
        });

        // Page navigation buttons (back/forward/refresh/home)
        document.querySelectorAll('.page-nav-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                var action = btn.dataset.nav;
                var container = document.getElementById('page-' + floorId);
                if (!container) return;
                var iframe = container.querySelector('iframe');
                if (!iframe) return;

                if (action === 'home') {
                    var section = document.getElementById('floor-' + floorId);
                    var originalPage = section ? section.dataset.page : null;
                    if (originalPage) {
                        var profile = findProfile(floorId);
                        var homeUrl = resolvePanelUrl(originalPage);
                        var pageCwd = (profile && (profile.cwd || defaultCwd)) || '';
                        if (pageCwd) {
                            homeUrl += (homeUrl.indexOf('?') === -1 ? '?' : '&') + 'path=' + encodeURIComponent(pageCwd);
                        }
                        iframe.src = homeUrl;
                    }
                } else if (action === 'refresh') {
                    try {
                        iframe.contentWindow.location.reload();
                    } catch (err) {
                        iframe.src = iframe.src;
                    }
                } else {
                    try {
                        if (action === 'back') iframe.contentWindow.history.back();
                        if (action === 'forward') iframe.contentWindow.history.forward();
                    } catch (err) {
                        // Cross-origin: cannot access history
                    }
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

        // Terminal text view (eye) buttons
        document.querySelectorAll('.term-view-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                openTerminalTextView(floorId);
            });
        });

        // Panel tab buttons (REFERENCE / TERMINAL)
        document.querySelectorAll('.panel-tab').forEach(function(tab) {
            tab.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = tab.dataset.floor;
                var tabName = tab.dataset.tab;
                switchPanelTab(floorId, tabName);
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
            var savedWidth = getPanelWidth(floorId);
            if (savedWidth) panel.style.width = savedWidth + 'px';
            btn.classList.add('panel-active');
            setPanelState(floorId, true);

            // Switch to reference tab when opening via [PANEL] button
            activePanelTab[floorId] = 'reference';
            updatePanelTabs(floorId);

            // Load content if not yet loaded
            var content = document.getElementById('panel-content-' + floorId);
            if (content && !content.hasChildNodes()) {
                MarkdownPanel.load(content, panelName);
            } else if (activePanelTab[floorId] === 'reference') {
                // Re-load reference content if we were on terminal tab
                content.innerHTML = '';
                MarkdownPanel.load(content, panelName);
            }
        } else {
            // Collapse panel
            panel.classList.add('collapsed');
            panel.style.width = '';
            btn.classList.remove('panel-active');
            setPanelState(floorId, false);
            // Also deactivate eye button
            var eyeBtn = document.querySelector('.term-view-btn[data-floor="' + floorId + '"]');
            if (eyeBtn) eyeBtn.classList.remove('panel-active');
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
            setPanelWidth(floorId, panel.offsetWidth);
            refitTerminal(floorId);
        }
    }

    // ==============================================================
    // TERMINAL TEXT VIEW (eye button)
    // ==============================================================
    // Track which tab is active per floor: 'reference' or 'terminal'
    var activePanelTab = {};  // floorId -> 'reference' | 'terminal'

    /**
     * Open the terminal text view in the side panel.
     * On desktop: expands the side panel with captured text.
     * On mobile: opens the left swipe panel with captured text.
     */
    function openTerminalTextView(floorId) {
        var isMobile = mobileMediaQuery.matches;

        if (isMobile) {
            openTerminalTextMobile(floorId);
        } else {
            openTerminalTextDesktop(floorId);
        }
    }

    function openTerminalTextDesktop(floorId) {
        var panel = document.getElementById('side-panel-' + floorId);
        if (!panel) return;

        var isCollapsed = panel.classList.contains('collapsed');
        var eyeBtn = document.querySelector('.term-view-btn[data-floor="' + floorId + '"]');

        // If panel is open on terminal tab, close it
        if (!isCollapsed && activePanelTab[floorId] === 'terminal') {
            panel.classList.add('collapsed');
            panel.style.width = '';
            if (eyeBtn) eyeBtn.classList.remove('panel-active');
            refitTerminal(floorId);
            return;
        }

        // Expand panel if collapsed
        if (isCollapsed) {
            panel.classList.remove('collapsed');
            var savedWidth = getPanelWidth(floorId);
            if (savedWidth) panel.style.width = savedWidth + 'px';
        }
        if (eyeBtn) eyeBtn.classList.add('panel-active');

        // Deactivate the panel toggle button if it exists
        var panelBtn = document.querySelector('.panel-toggle-btn[data-floor="' + floorId + '"]');
        if (panelBtn) panelBtn.classList.remove('panel-active');

        // Switch to terminal tab
        activePanelTab[floorId] = 'terminal';
        updatePanelTabs(floorId);

        // Load terminal capture
        var content = document.getElementById('panel-content-' + floorId);
        if (content) {
            captureTerminalText(floorId, content);
        }

        refitTerminal(floorId);
    }

    function openTerminalTextMobile(floorId) {
        clearFloorPanels();

        var profile = findProfile(floorId);
        var hasRefPanel = !!(profile && profile.panel);

        var wrapper = document.createElement('div');
        wrapper.className = 'swipe-markdown-panel';

        // Header with optional tabs
        if (hasRefPanel) {
            var tabBar = document.createElement('div');
            tabBar.className = 'swipe-panel-tabs';
            var refTab = document.createElement('button');
            refTab.className = 'swipe-panel-tab';
            refTab.textContent = 'REFERENCE';
            refTab.addEventListener('click', function() {
                refTab.classList.add('swipe-panel-tab-active');
                termTab.classList.remove('swipe-panel-tab-active');
                MarkdownPanel.load(contentDiv, profile.panel);
            });
            var termTab = document.createElement('button');
            termTab.className = 'swipe-panel-tab swipe-panel-tab-active';
            termTab.textContent = 'TERMINAL';
            termTab.addEventListener('click', function() {
                termTab.classList.add('swipe-panel-tab-active');
                refTab.classList.remove('swipe-panel-tab-active');
                captureTerminalText(floorId, contentDiv);
            });
            tabBar.appendChild(refTab);
            tabBar.appendChild(termTab);
            wrapper.appendChild(tabBar);
        } else {
            var header = document.createElement('div');
            header.className = 'swipe-markdown-header';
            header.textContent = 'TERMINAL OUTPUT';
            wrapper.appendChild(header);
        }

        var contentDiv = document.createElement('div');
        contentDiv.className = 'swipe-markdown-content industrial-prose';
        wrapper.appendChild(contentDiv);

        SwipePanels.registerPanel('left', wrapper);
        activeFloorPanelEdges.push('left');

        // Load the captured text
        captureTerminalText(floorId, contentDiv);

        // Open the swipe panel
        SwipePanels.showPanel('left');
    }

    /**
     * Fetch terminal capture and render as a markdown code block.
     * Adds a REFRESH button at the top.
     */
    function captureTerminalText(floorId, container) {
        container.innerHTML =
            '<div class="panel-loading">' +
            '<span class="panel-loading-text">CAPTURING...</span>' +
            '</div>';

        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/terminal/' + encodeURIComponent(floorId) + '/capture?lines=200', true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                var text = xhr.responseText;
                // Build refresh bar + markdown code block
                var refreshBar = document.createElement('div');
                refreshBar.className = 'term-view-refresh-bar';
                var refreshBtn = document.createElement('button');
                refreshBtn.className = 'power-btn term-view-refresh-btn';
                refreshBtn.textContent = '[REFRESH]';
                refreshBtn.addEventListener('click', function() {
                    captureTerminalText(floorId, container);
                });
                refreshBar.appendChild(refreshBtn);

                var contentWrap = document.createElement('pre');
                contentWrap.className = 'term-view-content';
                contentWrap.style.cssText = 'margin:0;padding:12px;overflow:auto;font-family:monospace;font-size:13px;white-space:pre;color:var(--steel-light);background:var(--steel-darkest);';
                contentWrap.textContent = text;

                container.innerHTML = '';
                container.appendChild(refreshBar);
                container.appendChild(contentWrap);
            } else {
                container.innerHTML =
                    '<div class="panel-error">' +
                    '<span class="panel-error-text">CAPTURE FAILED</span>' +
                    '<span class="panel-error-detail">HTTP ' + xhr.status + '</span>' +
                    '</div>';
            }
        };
        xhr.send();
    }

    /**
     * Switch between REFERENCE and TERMINAL tabs on desktop side panel.
     */
    function switchPanelTab(floorId, tabName) {
        activePanelTab[floorId] = tabName;
        updatePanelTabs(floorId);

        var content = document.getElementById('panel-content-' + floorId);
        if (!content) return;

        if (tabName === 'terminal') {
            captureTerminalText(floorId, content);
        } else {
            // Load markdown reference panel
            var profile = findProfile(floorId);
            if (profile && profile.panel) {
                content.innerHTML = '';
                MarkdownPanel.load(content, profile.panel);
            }
        }
    }

    /**
     * Update tab active states in the panel header.
     */
    function updatePanelTabs(floorId) {
        var tabs = document.querySelectorAll('.panel-tab[data-floor="' + floorId + '"]');
        var active = activePanelTab[floorId] || 'reference';
        tabs.forEach(function(tab) {
            if (tab.dataset.tab === active) {
                tab.classList.add('panel-tab-active');
            } else {
                tab.classList.remove('panel-tab-active');
            }
        });
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
        var pageUrl = resolvePanelUrl(profile.page);
        var pageCwd = profile.cwd || defaultCwd || '';
        if (pageCwd) {
            pageUrl += (pageUrl.indexOf('?') === -1 ? '?' : '&') + 'path=' + encodeURIComponent(pageCwd);
        }
        iframe.src = pageUrl;
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
        // Absolute or ~ paths go through the pages API for server-side resolution
        if (identifier.charAt(0) === '/' || identifier.charAt(0) === '~') {
            return '/api/pages/' + encodeURIComponent(identifier);
        }
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

        var isTerminal = !profile.page;
        var isMobile = mobileMediaQuery.matches;

        // On mobile, set up the left swipe panel for terminal floors
        if (isMobile && isTerminal) {
            var hasRefPanel = !!profile.panel;
            var wrapper = document.createElement('div');
            wrapper.className = 'swipe-markdown-panel';

            if (hasRefPanel) {
                // Tabbed header: REFERENCE / TERMINAL
                var tabBar = document.createElement('div');
                tabBar.className = 'swipe-panel-tabs';
                var refTab = document.createElement('button');
                refTab.className = 'swipe-panel-tab swipe-panel-tab-active';
                refTab.textContent = 'REFERENCE';
                var termTab = document.createElement('button');
                termTab.className = 'swipe-panel-tab';
                termTab.textContent = 'TERMINAL';
                var contentDiv = document.createElement('div');
                contentDiv.className = 'swipe-markdown-content industrial-prose';

                refTab.addEventListener('click', function() {
                    refTab.classList.add('swipe-panel-tab-active');
                    termTab.classList.remove('swipe-panel-tab-active');
                    MarkdownPanel.load(contentDiv, profile.panel);
                });
                termTab.addEventListener('click', function() {
                    termTab.classList.add('swipe-panel-tab-active');
                    refTab.classList.remove('swipe-panel-tab-active');
                    captureTerminalText(floorId, contentDiv);
                });

                tabBar.appendChild(refTab);
                tabBar.appendChild(termTab);
                wrapper.appendChild(tabBar);
                wrapper.appendChild(contentDiv);

                SwipePanels.registerPanel('left', wrapper);
                activeFloorPanelEdges.push('left');
                MarkdownPanel.load(contentDiv, profile.panel);
            } else {
                // No markdown panel -- just terminal header
                var header = document.createElement('div');
                header.className = 'swipe-markdown-header';
                header.textContent = 'TERMINAL OUTPUT';
                wrapper.appendChild(header);

                var contentDiv2 = document.createElement('div');
                contentDiv2.className = 'swipe-markdown-content industrial-prose';
                wrapper.appendChild(contentDiv2);

                // Add refresh button
                var refreshBar = document.createElement('div');
                refreshBar.className = 'term-view-refresh-bar';
                var refreshBtn = document.createElement('button');
                refreshBtn.className = 'power-btn term-view-refresh-btn';
                refreshBtn.textContent = '[REFRESH]';
                refreshBtn.addEventListener('click', function() {
                    captureTerminalText(floorId, contentDiv2);
                });
                refreshBar.appendChild(refreshBtn);
                contentDiv2.appendChild(refreshBar);

                SwipePanels.registerPanel('left', wrapper);
                activeFloorPanelEdges.push('left');
            }
        } else if (isMobile && profile.panel) {
            // Non-terminal floor with markdown panel (legacy path)
            var wrapper2 = document.createElement('div');
            wrapper2.className = 'swipe-markdown-panel';
            var header2 = document.createElement('div');
            header2.className = 'swipe-markdown-header';
            header2.textContent = 'REFERENCE';
            wrapper2.appendChild(header2);
            var content2 = document.createElement('div');
            content2.className = 'swipe-markdown-content industrial-prose';
            wrapper2.appendChild(content2);
            SwipePanels.registerPanel('left', wrapper2);
            activeFloorPanelEdges.push('left');
            MarkdownPanel.load(content2, profile.panel);
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
    // LOBBY PROFILE MANAGEMENT
    // ==============================================================
    function buildLobbyProfileCardHTML(profile, index) {
        var name = profile.name || 'Untitled';
        var icon = profile.icon || '';
        var command = profile.command || '';
        var cwd = profile.cwd || '';
        var panel = profile.panel || '';
        var page = profile.page || '';
        var enabled = profile.enabled !== false;
        var isFirst = index === 0;
        var isLast = index === profiles.length - 1;

        var statusClass = enabled ? 'enabled' : 'disabled-badge';
        var statusText = enabled ? 'ON' : 'OFF';
        var disabledClass = enabled ? '' : ' disabled';

        return '' +
            '<div class="lobby-profile-item' + disabledClass + '" data-index="' + index + '">' +
                '<div class="lobby-profile-summary" data-index="' + index + '">' +
                    '<span class="lobby-profile-icon">' + escapeHtml(icon || String(index + 1)) + '</span>' +
                    '<span class="lobby-profile-name">' + escapeHtml(name) + '</span>' +
                    '<span class="lobby-profile-type ' + (page ? 'type-page' : 'type-trm') + '">' + (page ? 'PAGE' : 'TRM') + '</span>' +
                    '<span class="lobby-profile-cmd">' + escapeHtml(command || '—') + '</span>' +
                    '<span class="lobby-profile-status ' + statusClass + '">' + statusText + '</span>' +
                    '<button class="lobby-move-btn" data-action="move-up" data-index="' + index + '"' + (isFirst ? ' disabled' : '') + '>&#9650;</button>' +
                    '<button class="lobby-move-btn" data-action="move-down" data-index="' + index + '"' + (isLast ? ' disabled' : '') + '>&#9660;</button>' +
                '</div>' +
                '<div class="lobby-profile-edit" data-index="' + index + '">' +
                    '<div class="edit-field">' +
                        '<label>NAME</label>' +
                        '<input type="text" class="edit-input lobby-edit-name" value="' + escapeAttr(name) + '">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>COMMAND <span class="label-hint">(blank for page floors)</span></label>' +
                        '<input type="text" class="edit-input lobby-edit-command" value="' + escapeAttr(command) + '">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>CWD <span class="label-hint">(blank = inherit global)</span></label>' +
                        '<input type="text" class="edit-input lobby-edit-cwd" value="' + escapeAttr(cwd) + '" placeholder="' + escapeAttr(defaultCwd || '~') + '">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>ICON</label>' +
                        '<input type="text" class="edit-input edit-input-icon lobby-edit-icon" value="' + escapeAttr(icon) + '" placeholder="emoji">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>PANEL <span class="label-hint">(markdown filename)</span></label>' +
                        '<input type="text" class="edit-input lobby-edit-panel" value="' + escapeAttr(panel) + '" placeholder="(optional)">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>PAGE <span class="label-hint">(HTML path — sets floor as page type)</span></label>' +
                        '<input type="text" class="edit-input lobby-edit-page" value="' + escapeAttr(page) + '" placeholder="(optional)">' +
                    '</div>' +
                    '<div class="lobby-edit-actions">' +
                        '<button class="lobby-save-btn" data-action="save" data-index="' + index + '">[SAVE]</button>' +
                        '<button class="lobby-cancel-btn" data-action="cancel" data-index="' + index + '">[CANCEL]</button>' +
                        '<button class="lobby-toggle-btn" data-action="toggle" data-index="' + index + '">[' + (enabled ? 'DISABLE' : 'ENABLE') + ']</button>' +
                        '<button class="lobby-delete-btn" data-action="delete" data-index="' + index + '">[DELETE]</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    function renderLobbyProfiles() {
        var container = document.getElementById('lobby-profile-list');
        if (!container) return;

        var html = '';
        for (var i = profiles.length - 1; i >= 0; i--) {
            html += buildLobbyProfileCardHTML(profiles[i], i);
        }
        container.innerHTML = html;
    }

    function serializeProfiles() {
        return profiles.map(function(p) {
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
    }

    function saveLobbyProfiles(onSuccess) {
        var body = JSON.stringify({
            default_cwd: defaultCwd,
            profiles: serializeProfiles(),
        });

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
            renderLobbyProfiles();
            renderFloors(profiles);
            if (onSuccess) onSuccess();
            console.log('[CodeFactory] Lobby profiles saved');
        })
        .catch(function(err) {
            console.error('[CodeFactory] Failed to save lobby profiles:', err);
        });
    }

    function initLobbyRefresh() {
        var btn = document.getElementById('lobby-refresh-btn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            playClick();
            window.location.reload();
        });
    }

    function initLobbyShutdown() {
        var btn = document.getElementById('lobby-shutdown-btn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            if (!confirm('Shut down CodeFactory backend?')) return;
            playClick();
            fetch('/api/shutdown', { method: 'POST' }).catch(function() {});
            btn.textContent = '[SHUTTING DOWN...]';
            btn.disabled = true;
        });
    }

    function initLobbySettings() {
        var container = document.getElementById('lobby-profiles');
        var addBtn = document.getElementById('lobby-add-btn');
        if (!container) return;

        renderLobbyProfiles();

        // Event delegation on the profile list
        container.addEventListener('click', function(e) {
            var target = e.target;

            // Move up/down buttons
            if (target.classList.contains('lobby-move-btn')) {
                e.stopPropagation();
                var action = target.dataset.action;
                var idx = parseInt(target.dataset.index, 10);
                if (action === 'move-up' && idx > 0) {
                    var tmp = profiles[idx];
                    profiles[idx] = profiles[idx - 1];
                    profiles[idx - 1] = tmp;
                    saveLobbyProfiles();
                } else if (action === 'move-down' && idx < profiles.length - 1) {
                    var tmp2 = profiles[idx];
                    profiles[idx] = profiles[idx + 1];
                    profiles[idx + 1] = tmp2;
                    saveLobbyProfiles();
                }
                return;
            }

            // Edit form action buttons
            var actionBtn = target.closest('[data-action]');
            if (actionBtn && actionBtn.dataset.action !== 'move-up' && actionBtn.dataset.action !== 'move-down') {
                e.stopPropagation();
                var btnAction = actionBtn.dataset.action;
                var btnIdx = parseInt(actionBtn.dataset.index, 10);

                if (btnAction === 'save') {
                    var editDiv = container.querySelector('.lobby-profile-edit[data-index="' + btnIdx + '"]');
                    if (!editDiv) return;

                    var newName = editDiv.querySelector('.lobby-edit-name').value.trim();
                    if (!newName) {
                        editDiv.querySelector('.lobby-edit-name').classList.add('input-error');
                        setTimeout(function() {
                            editDiv.querySelector('.lobby-edit-name').classList.remove('input-error');
                        }, 1000);
                        return;
                    }

                    var newCmd = editDiv.querySelector('.lobby-edit-command').value.trim();
                    var newCwd = editDiv.querySelector('.lobby-edit-cwd').value.trim();
                    var newIcon = editDiv.querySelector('.lobby-edit-icon').value.trim();
                    var newPanel = editDiv.querySelector('.lobby-edit-panel').value.trim();
                    var newPage = editDiv.querySelector('.lobby-edit-page').value.trim();

                    profiles[btnIdx].name = newName;
                    profiles[btnIdx].command = newCmd || null;
                    profiles[btnIdx].cwd = (newCwd && newCwd !== defaultCwd) ? newCwd : null;
                    profiles[btnIdx].icon = newIcon || null;
                    profiles[btnIdx].panel = newPanel || null;
                    profiles[btnIdx].page = newPage || null;

                    actionBtn.textContent = '[SAVING...]';
                    saveLobbyProfiles(function() {
                        // Collapse form after save
                        editDiv.style.display = 'none';
                    });

                } else if (btnAction === 'cancel') {
                    var editForm = container.querySelector('.lobby-profile-edit[data-index="' + btnIdx + '"]');
                    if (editForm) editForm.style.display = 'none';

                } else if (btnAction === 'toggle') {
                    var wasEnabled = profiles[btnIdx].enabled !== false;
                    profiles[btnIdx].enabled = !wasEnabled;
                    saveLobbyProfiles();

                } else if (btnAction === 'delete') {
                    var profileName = profiles[btnIdx].name || 'this profile';
                    if (!confirm('Delete "' + profileName + '"? This cannot be undone.')) return;
                    profiles.splice(btnIdx, 1);
                    saveLobbyProfiles();
                }
                return;
            }

            // Click on summary row to expand/collapse edit form
            var summary = target.closest('.lobby-profile-summary');
            if (summary) {
                var summaryIdx = parseInt(summary.dataset.index, 10);
                var editPanel = container.querySelector('.lobby-profile-edit[data-index="' + summaryIdx + '"]');
                if (editPanel) {
                    var isVisible = editPanel.style.display === 'block';
                    // Collapse all others first
                    container.querySelectorAll('.lobby-profile-edit').forEach(function(el) {
                        el.style.display = 'none';
                    });
                    if (!isVisible) {
                        editPanel.style.display = 'block';
                    }
                }
            }
        });

        // Add profile button
        if (addBtn) {
            addBtn.addEventListener('click', function() {
                profiles.push({
                    name: 'New Profile',
                    command: null,
                    cwd: null,
                    icon: null,
                    panel: null,
                    page: null,
                    enabled: true,
                });
                saveLobbyProfiles(function() {
                    // Auto-expand the new profile's edit form
                    var lastEdit = container.querySelector('.lobby-profile-edit[data-index="' + (profiles.length - 1) + '"]');
                    if (lastEdit) {
                        lastEdit.style.display = 'block';
                        var nameInput = lastEdit.querySelector('.lobby-edit-name');
                        if (nameInput) {
                            setTimeout(function() { nameInput.focus(); nameInput.select(); }, 50);
                        }
                    }
                });
            });
        }
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
    // UNIFIED MOBILE BAR (swipeable keys + nav)
    // ==============================================================
    var mobileBar = null;
    var mobileBarTrack = null;
    var mobileBarDots = null;
    var mobileBarPanel = 0;          // 0 = keys, 1 = nav
    var mobileBarUserOverride = false; // user swiped manually
    var mobileMediaQuery = window.matchMedia('(max-width: 768px)');

    function setupMobileBar() {
        var isMobile = mobileMediaQuery.matches;

        if (isMobile && !mobileBar && floorCount > 0) {
            mobileBar = document.createElement('nav');
            mobileBar.className = 'mobile-bar';

            // Track container (slides left/right)
            mobileBarTrack = document.createElement('div');
            mobileBarTrack.className = 'mobile-bar-track';

            // Panel 0: Extra keys
            var keysPanel;
            if (typeof ExtraKeys !== 'undefined') {
                keysPanel = ExtraKeys.createKeysPanel();
            } else {
                keysPanel = document.createElement('div');
                keysPanel.className = 'mobile-bar-panel mobile-bar-keys';
            }
            mobileBarTrack.appendChild(keysPanel);

            // Panel 1: Chat input
            var chatPanel = document.createElement('div');
            chatPanel.className = 'mobile-bar-panel mobile-bar-chat';

            var chatForm = document.createElement('form');
            chatForm.className = 'mobile-bar-chat-form';
            chatForm.setAttribute('action', 'javascript:void(0)');

            var chatInput = document.createElement('input');
            chatInput.type = 'text';
            chatInput.className = 'mobile-bar-chat-input';
            chatInput.placeholder = 'type here...';
            chatInput.setAttribute('autocomplete', 'one-time-code');
            chatInput.autocapitalize = 'off';
            chatInput.spellcheck = false;
            chatInput.enterKeyHint = 'send';
            chatInput.setAttribute('data-form-type', 'other');
            chatInput.setAttribute('data-lpignore', 'true');
            chatInput.setAttribute('aria-autocomplete', 'none');

            // Prevent swipe detection when interacting with input
            chatInput.addEventListener('touchstart', function(e) {
                e.stopPropagation();
            }, { passive: true });

            var chatSend = document.createElement('button');
            chatSend.type = 'button';
            chatSend.className = 'mobile-bar-chat-send';
            chatSend.textContent = '\u25B6';

            function sendChatInput() {
                var text = chatInput.value;
                if (!text) return;
                var floorId = currentFloor ? currentFloor.replace('floor-', '') : null;
                if (!floorId || floorId === 'lobby') return;
                if (typeof CodeFactoryTerminals === 'undefined') return;

                var entry = CodeFactoryTerminals.getTerminal(floorId);
                if (!entry || entry.inputGuarded || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) return;

                // Send text first
                var encoded = btoa(unescape(encodeURIComponent(text)));
                entry.ws.send(JSON.stringify({ type: 'terminal-input', data: encoded }));

                // Send Enter after delay (needs to be long enough for apps
                // like Claude Code to finish processing the pasted text)
                setTimeout(function() {
                    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
                        var enterEncoded = btoa('\r');
                        entry.ws.send(JSON.stringify({ type: 'terminal-input', data: enterEncoded }));
                    }
                }, 800);

                chatInput.value = '';
            }

            chatForm.addEventListener('submit', function(e) {
                e.preventDefault();
                sendChatInput();
            });

            chatSend.addEventListener('touchstart', function(e) {
                e.preventDefault();
                e.stopPropagation();
                sendChatInput();
            }, { passive: false });

            chatSend.addEventListener('click', function(e) {
                e.preventDefault();
                sendChatInput();
            });

            chatForm.appendChild(chatInput);
            chatForm.appendChild(chatSend);
            chatPanel.appendChild(chatForm);
            mobileBarTrack.appendChild(chatPanel);

            // Panel 2: Elevator nav
            var navPanel = document.createElement('div');
            navPanel.className = 'mobile-bar-panel mobile-bar-nav';

            var navInner = document.createElement('div');
            navInner.className = 'mobile-bar-nav-inner';

            // Lobby button
            var lobbyBtn = document.createElement('button');
            lobbyBtn.className = 'mobile-bar-btn';
            lobbyBtn.setAttribute('data-target', 'lobby');
            lobbyBtn.setAttribute('data-label', 'Lobby');
            lobbyBtn.textContent = 'L';
            if (currentFloor === 'lobby') lobbyBtn.classList.add('active');
            navInner.appendChild(lobbyBtn);

            // Floor buttons (lowest first)
            var desktopBtns = elevatorButtons.querySelectorAll('.floor-btn');
            for (var i = desktopBtns.length - 1; i >= 0; i--) {
                var srcBtn = desktopBtns[i];
                var btn = document.createElement('button');
                btn.className = 'mobile-bar-btn';
                btn.setAttribute('data-target', srcBtn.dataset.target);
                btn.setAttribute('data-label', srcBtn.dataset.label);
                btn.innerHTML = srcBtn.innerHTML;
                if (srcBtn.dataset.target === currentFloor) btn.classList.add('active');
                navInner.appendChild(btn);
            }

            navPanel.appendChild(navInner);
            mobileBarTrack.appendChild(navPanel);

            // Nav button click handlers
            var barBtns = navInner.querySelectorAll('.mobile-bar-btn');
            for (var j = 0; j < barBtns.length; j++) {
                barBtns[j].addEventListener('click', (function(mbtn) {
                    return function() {
                        playClick();
                        var targetId = mbtn.dataset.target;
                        var target = document.getElementById(targetId);
                        if (target) {
                            jumpTarget = targetId;
                            target.scrollIntoView({ behavior: 'instant', block: 'start' });
                            currentFloor = targetId;
                            jumpTarget = null;
                            syncMobileBar();
                            var floorNum = targetId.replace('floor-', '');
                            if (floorNum !== 'lobby') {
                                CodeFactoryTerminals.focus(floorNum);
                            }
                        }
                    };
                })(barBtns[j]));
            }

            mobileBar.appendChild(mobileBarTrack);

            // Dot indicators
            mobileBarDots = document.createElement('div');
            mobileBarDots.className = 'mobile-bar-dots';
            mobileBarDots.innerHTML = '<span class="mobile-bar-dot"></span><span class="mobile-bar-dot"></span><span class="mobile-bar-dot"></span>';
            mobileBar.appendChild(mobileBarDots);

            // Swipe gesture
            initBarSwipe();

            document.body.appendChild(mobileBar);

            // Set initial panel based on context
            mobileBarUserOverride = false;
            autoSelectPanel();

            // Set floor for extra keys
            if (typeof ExtraKeys !== 'undefined') {
                ExtraKeys.setFloor(currentFloor);
            }

        } else if (!isMobile && mobileBar) {
            mobileBar.remove();
            mobileBar = null;
            mobileBarTrack = null;
            mobileBarDots = null;
        }
    }

    function setBarPanel(index) {
        mobileBarPanel = index;
        if (mobileBarTrack) {
            var pct = index * -33.333;
            mobileBarTrack.style.transform = 'translateX(' + pct + '%)';
            // Disable pointer-events on off-screen panels so their elements
            // can't intercept taps (mobile browsers don't always clip touch
            // targets with overflow:hidden on transformed containers).
            var panels = mobileBarTrack.querySelectorAll('.mobile-bar-panel');
            for (var i = 0; i < panels.length; i++) {
                panels[i].style.pointerEvents = (i === index) ? '' : 'none';
            }
        }
        if (mobileBarDots) {
            var dots = mobileBarDots.querySelectorAll('.mobile-bar-dot');
            for (var i = 0; i < dots.length; i++) {
                dots[i].classList.toggle('active', i === index);
            }
        }
    }

    function autoSelectPanel() {
        if (typeof ExtraKeys !== 'undefined' && ExtraKeys.isTerminalFloor(currentFloor)) {
            setBarPanel(0);
        } else {
            setBarPanel(2);
        }
    }

    function initBarSwipe() {
        var startX = 0;
        var startY = 0;
        var tracking = false;
        var inhibited = false; // true when nav inner can scroll in swipe direction
        var navInnerEl = null;
        var barWidth = 0;
        var panelCount = 3;

        // Find the nav-inner element if the touch is inside it
        function findNavInner(target) {
            var el = target;
            while (el && el !== mobileBar) {
                if (el.classList.contains('mobile-bar-nav-inner')) return el;
                el = el.parentElement;
            }
            return null;
        }

        mobileBar.addEventListener('touchstart', function(e) {
            // Don't intercept key button taps (they stopPropagation)
            if (e.target.classList.contains('extra-key-btn')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = false;
            inhibited = false;
            navInnerEl = findNavInner(e.target);
            barWidth = mobileBar.offsetWidth;
        }, { passive: true });

        mobileBar.addEventListener('touchmove', function(e) {
            if (e.target.classList.contains('extra-key-btn')) return;
            if (inhibited) return; // let the inner element scroll
            var dx = e.touches[0].clientX - startX;
            var dy = e.touches[0].clientY - startY;

            // Determine direction on first significant move
            if (!tracking) {
                if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
                    // If inside nav scroll, only inhibit if nav can scroll in this direction
                    if (navInnerEl) {
                        var canScrollRight = navInnerEl.scrollLeft < navInnerEl.scrollWidth - navInnerEl.clientWidth - 1;
                        var canScrollLeft = navInnerEl.scrollLeft > 1;
                        // Swiping left (dx < 0) scrolls content right, swiping right scrolls left
                        if ((dx < 0 && canScrollRight) || (dx > 0 && canScrollLeft)) {
                            inhibited = true;
                            return;
                        }
                    }
                    tracking = true;
                    mobileBarTrack.classList.add('dragging');
                } else if (Math.abs(dy) > 8) {
                    return; // vertical scroll, ignore
                } else {
                    return; // not enough movement yet
                }
            }

            if (tracking) {
                e.preventDefault();
                // Translate track following finger
                var baseOffset = -mobileBarPanel * barWidth;
                var offset = baseOffset + dx;
                // Clamp: don't scroll past edges
                var maxOffset = -(panelCount - 1) * barWidth;
                offset = Math.max(maxOffset, Math.min(0, offset));
                mobileBarTrack.style.transform = 'translateX(' + offset + 'px)';
            }
        }, { passive: false });

        mobileBar.addEventListener('touchend', function(e) {
            if (inhibited) { inhibited = false; return; }
            if (!tracking) return;
            tracking = false;
            mobileBarTrack.classList.remove('dragging');

            var dx = e.changedTouches[0].clientX - startX;
            var threshold = barWidth * 0.25;

            var newPanel = mobileBarPanel;
            if (dx < -threshold && mobileBarPanel < panelCount - 1) {
                // Swipe left: next panel
                newPanel = mobileBarPanel + 1;
            } else if (dx > threshold && mobileBarPanel > 0) {
                // Swipe right: previous panel
                newPanel = mobileBarPanel - 1;
            }

            if (newPanel !== mobileBarPanel) {
                mobileBarUserOverride = true;
            }
            setBarPanel(newPanel);
        }, { passive: true });
    }

    function syncMobileBar() {
        if (!mobileBar) return;

        // Update nav button active states
        var barBtns = mobileBar.querySelectorAll('.mobile-bar-btn');
        for (var i = 0; i < barBtns.length; i++) {
            barBtns[i].classList.toggle('active', barBtns[i].dataset.target === currentFloor);
        }

        // Scroll active nav button into view within the nav container
        var activeBtn = mobileBar.querySelector('.mobile-bar-btn.active');
        if (activeBtn) {
            var navInner = activeBtn.parentElement;
            if (navInner && navInner.classList.contains('mobile-bar-nav-inner')) {
                var btnLeft = activeBtn.offsetLeft;
                var btnWidth = activeBtn.offsetWidth;
                var scrollLeft = navInner.scrollLeft;
                var containerWidth = navInner.clientWidth;
                // Center the button in the scrollable container
                navInner.scrollLeft = btnLeft - (containerWidth - btnWidth) / 2;
            }
        }

        // Update extra keys floor
        if (typeof ExtraKeys !== 'undefined') {
            ExtraKeys.setFloor(currentFloor);
        }

        // Auto-switch panel unless user manually swiped
        if (!mobileBarUserOverride) {
            autoSelectPanel();
        }

        // Reset override on floor change so next navigation auto-selects
        mobileBarUserOverride = false;
    }

    // Listen for viewport changes
    mobileMediaQuery.addEventListener('change', function() {
        setupMobileBar();
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
        viewObserver = new IntersectionObserver(function (entries) {
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
            // Skip scroll-based updates during jump animations or viewport resizes (keyboard)
            if (resizeGuard) return;
            if (jumpTarget && mobileMediaQuery.matches) return;
            var isMobile = mobileMediaQuery.matches;
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

                // Door animation (desktop only — doors are hidden on mobile)
                if (!isMobile) {
                    var floorCenter = rect.top + rect.height / 2;
                    var vpCenter = vh / 2;
                    var dist = Math.abs(floorCenter - vpCenter) / vh;
                    var openness = Math.max(0, Math.min(1, (0.9 - dist) / 0.65));
                    openness = openness * openness * (3 - 2 * openness);
                    if (jumpTarget && floor.id !== jumpTarget) {
                        openness = 0;
                    }
                    floor.style.setProperty('--door-open', openness);
                }
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

                // Apply per-floor swipe panels for the new floor (desktop only)
                if (!isMobile) {
                    applyFloorPanels(bestFloor.replace('floor-', ''));
                }

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

                if (!isMobile) {
                    indicator.classList.add('flash');
                    setTimeout(function () {
                        indicator.classList.remove('flash');
                    }, 300);

                    if (newRank > prevRank) {
                        arrow.innerHTML = '&#9650;';
                    } else {
                        arrow.innerHTML = '&#9660;';
                    }
                }

                buttons.forEach(function (btn) {
                    btn.classList.toggle('active', btn.dataset.target === bestFloor);
                });

                // Sync mobile bar
                syncMobileBar();
            }
        }

        // Button clicks — delegated so they survive DOM rebuilds
        document.querySelector('.panel-frame').addEventListener('click', function (e) {
            var btn = e.target.closest('.floor-btn');
            if (!btn) return;
            playClick();
            var targetId = btn.dataset.target;
            var target = document.getElementById(targetId);
            if (target) {
                jumpTarget = targetId;
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });

        // Keyboard navigation (Alt+1-9 jump to floors, Escape exits edit)
        document.addEventListener('keydown', function (e) {
            // Ignore if user is typing in an input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            // Escape exits edit mode
            if (e.key === 'Escape' && editingFloor) {
                exitEditMode(editingFloor);
                return;
            }

            // Alt+number: jump to floor N
            if (e.altKey && !e.ctrlKey && !e.metaKey) {
                var targetId = null;
                if (e.key === 'l' || e.key === 'L' || e.key === '0') {
                    targetId = 'lobby';
                } else {
                    var num = parseInt(e.key, 10);
                    if (num >= 1 && num <= 9 && num <= floors.length) {
                        // floors array is ordered by DOM position; map Nth floor
                        var floorEl = floors[num - 1];
                        if (floorEl) targetId = floorEl.id;
                    }
                }

                if (targetId) {
                    e.preventDefault();
                    playClick();
                    var target = document.getElementById(targetId);
                    if (target) {
                        jumpTarget = targetId;
                        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
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
        // Uses a resize guard to prevent scroll handler from jumping floors
        // during keyboard open/close when floor heights change.
        var resizeGuard = false;
        if (window.visualViewport) {
            var vvTick = null;
            function updateVisualViewport() {
                var vh = window.visualViewport.height;
                document.documentElement.style.setProperty('--vvh', vh + 'px');

                // Lock scroll to current floor during resize
                resizeGuard = true;
                var currentEl = document.getElementById(currentFloor);
                if (currentEl) {
                    currentEl.scrollIntoView({ behavior: 'instant', block: 'start' });
                }

                clearTimeout(vvTick);
                vvTick = setTimeout(function() {
                    refitAllTerminals();
                    // Re-anchor after refit
                    var el = document.getElementById(currentFloor);
                    if (el) {
                        el.scrollIntoView({ behavior: 'instant', block: 'start' });
                    }
                    resizeGuard = false;
                }, 200);
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
