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
    // editingFloor state moved to FloorEdit (floor-edit.js)

    // These are rebuilt after floors render
    var floors = [];   // NodeList -> array of section.floor elements
    var buttons = [];  // NodeList -> array of .floor-btn elements
    var floorLabels = {};  // id -> label string
    var floorRank = {};    // id -> numeric rank
    var viewObserver = null; // IntersectionObserver for entrance animations, created in initElevatorMechanics
    var activeFloorObserver = null; // IntersectionObserver for active floor detection, created in initElevatorMechanics
    var floorRatios = {};  // floor.id -> intersectionRatio, used by activeFloorObserver

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
            initMobileManager();
            MobileManager.setupMobileBar();
            LobbyManager.init(profiles, defaultCwd, renderFloors, function(cwd) { defaultCwd = cwd; });
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

        // Re-observe new floor elements for entrance animations and active floor detection
        if (viewObserver) {
            floors.forEach(function(floor) {
                viewObserver.observe(floor);
            });
        }
        if (activeFloorObserver) {
            // Clear stale ratios and re-observe all floors + lobby
            floorRatios = {};
            floors.forEach(function(floor) {
                activeFloorObserver.observe(floor);
            });
            var lobbyEl = document.getElementById('lobby');
            if (lobbyEl) {
                activeFloorObserver.observe(lobbyEl);
            }
        }

        // Attach floor event listeners (power on/off, edit)
        attachFloorListeners(enabledProfiles);

        // Rebuild mobile bottom bar to reflect new floors
        MobileManager.teardown();
        MobileManager.setupMobileBar();

        // Auto-load page floors
        autoLoadPageFloors(enabledProfiles);
    }

    // PANEL STATE & TOGGLE/RESIZE — see panels.js (PanelManager)

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
        var panelOpen = hasPanel && PanelManager.getPanelState(floorId);

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
        var savedWidth = PanelManager.getPanelWidth(floorId);
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

        var tempClass = profile._temp ? ' temp-floor' : '';

        return '' +
            '<section class="floor powered-off' + tempClass + '" id="floor-' + floorId + '">' +
                '<div class="elevator-doors">' +
                    '<div class="door door-left"></div>' +
                    '<div class="door door-right"></div>' +
                '</div>' +
                '<div class="floor-frame">' +
                    '<div class="floor-header">' +
                        '<span class="floor-label">' + (icon ? escapeHtml(icon) + ' ' : '') + 'Floor ' + floorId + (profile._temp ? ' [TEMP]' : '') + '</span>' +
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
                    '<!-- Detach / Kill / Duplicate buttons (shown when powered on) -->' +
                    '<div class="power-off-bar" id="power-off-bar-' + floorId + '">' +
                        '<button class="power-btn detach-btn" data-floor="' + floorId + '">[DETACH]</button>' +
                        '<button class="power-btn kill-btn" data-floor="' + floorId + '">[KILL]</button>' +
                        (profile._temp ? '' : '<button class="power-btn dupe-btn" data-floor="' + floorId + '" title="Duplicate as transient floor">[DUPE]</button>') +
                    '</div>' +
                '</div>' +
            '</section>';
    }

    function buildPageFloorHTML(floorId, profile, name, icon) {
        var builtinClass = isBuiltinPage(profile) ? ' builtin-page-floor' : '';
        return '' +
            '<section class="floor powered-off' + builtinClass + '" id="floor-' + floorId + '" data-page="' + escapeAttr(profile.page) + '">' +
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
                    '<div class="edit-field-row">' +
                        '<input type="text" class="edit-input" id="edit-cwd-' + floorId + '" value="' + escapeAttr(cwd) + '" placeholder="' + escapeAttr(defaultCwd || '~') + '">' +
                        '<button type="button" class="browse-btn" data-browse="cwd" data-floor="' + floorId + '">BROWSE</button>' +
                    '</div>' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>ICON</label>' +
                    '<input type="text" class="edit-input edit-input-icon" id="edit-icon-' + floorId + '" value="' + escapeAttr(icon) + '" placeholder="emoji">' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>PANEL <span class="label-hint">(markdown filename, e.g. claude.md)</span></label>' +
                    '<div class="edit-field-row">' +
                        '<input type="text" class="edit-input" id="edit-panel-' + floorId + '" value="' + escapeAttr(profile.panel || '') + '" placeholder="(optional)">' +
                        '<button type="button" class="browse-btn" data-browse="panel" data-floor="' + floorId + '">BROWSE</button>' +
                    '</div>' +
                '</div>' +
                '<div class="edit-field">' +
                    '<label>PAGE <span class="label-hint">(HTML file path — sets floor as page type)</span></label>' +
                    '<div class="edit-field-row">' +
                        '<input type="text" class="edit-input" id="edit-page-' + floorId + '" value="' + escapeAttr(profile.page || '') + '" placeholder="(optional)">' +
                        '<button type="button" class="browse-btn" data-browse="page" data-floor="' + floorId + '">BROWSE</button>' +
                    '</div>' +
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
            var tempClass = profile._temp ? ' floor-btn-temp' : '';
            html += '<button class="floor-btn' + iconClass + pageClass + tempClass + '" data-target="floor-' + floorId +
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
                            MobileManager.syncMobileBar();
                        }, 200);
                        // If panel is configured and was open, load its content
                        if (profile.panel && PanelManager.getPanelState(floorId)) {
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
                MobileManager.syncMobileBar();
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
                    // If this was a temp floor, remove it from profiles and DOM
                    if (profile && profile._temp) {
                        setTimeout(function() {
                            removeTempFloor(floorId);
                        }, 100);
                    }
                }
                MobileManager.syncMobileBar();
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

        // Duplicate buttons (spawn transient clone)
        document.querySelectorAll('.dupe-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                duplicateFloor(floorId);
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

        // Browse buttons (file picker for cwd, panel, page fields)
        document.querySelectorAll('.browse-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var field = btn.dataset.browse;
                var floorId = btn.dataset.floor;
                var inputId = 'edit-' + field + '-' + floorId;
                var input = document.getElementById(inputId);
                var mode = (field === 'cwd') ? 'dir' : 'file';
                var startPath = (input && input.value) ? input.value : (defaultCwd || '~');
                FilePicker.open({
                    mode: mode,
                    startPath: startPath,
                    onSelect: function(path) {
                        if (input) input.value = path;
                    }
                });
            });
        });

        // Panel toggle buttons
        document.querySelectorAll('.panel-toggle-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                var panelName = btn.dataset.panel;
                PanelManager.togglePanel(floorId, panelName, btn, { activePanelTab: TextViewer.activePanelTab, updatePanelTabs: TextViewer.updatePanelTabs });
            });
        });

        // Terminal text view (eye) buttons
        document.querySelectorAll('.term-view-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                TextViewer.openTerminalTextView(floorId, { mobileMediaQuery: mobileMediaQuery, clearFloorPanels: clearFloorPanels, activeFloorPanelEdges: activeFloorPanelEdges, findProfile: findProfile });
            });
        });

        // Panel tab buttons (REFERENCE / TERMINAL)
        document.querySelectorAll('.panel-tab').forEach(function(tab) {
            tab.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = tab.dataset.floor;
                var tabName = tab.dataset.tab;
                TextViewer.switchPanelTab(floorId, tabName, findProfile);
            });
        });

        // Panel resize handles
        document.querySelectorAll('.panel-resize-handle').forEach(function(handle) {
            PanelManager.initPanelResize(handle);
        });

        // Click-to-focus on terminal containers
        document.querySelectorAll('.terminal-container').forEach(function(container) {
            container.addEventListener('mousedown', function() {
                var floorId = container.id.replace('terminal-', '');
                CodeFactoryTerminals.focus(floorId);
            });
        });
    }

    // TERMINAL TEXT VIEW — extracted to text-view.js (TextViewer)

    // ==============================================================
    // PAGE FLOOR HELPERS
    // ==============================================================

    /**
     * Inject industrial scrollbar styles and jump-link fix into a same-origin iframe.
     */
    function injectIframeTheme(iframe) {
        iframe.addEventListener('load', function() {
            try {
                var doc = iframe.contentDocument;
                if (!doc) return;

                // Industrial scrollbar CSS
                var style = doc.createElement('style');
                style.textContent =
                    '/* Industrial scrollbar theme (injected by CodeFactory) */\n' +
                    '::-webkit-scrollbar { width: 8px; height: 8px; }\n' +
                    '::-webkit-scrollbar-track { background: #1A1D1F; border-left: 1px solid #4A5459; }\n' +
                    '::-webkit-scrollbar-thumb { background: linear-gradient(180deg, #7A8489 0%, #4A5459 100%); border: 1px solid #2C3033; border-radius: 2px; }\n' +
                    '::-webkit-scrollbar-thumb:hover { background: linear-gradient(180deg, #9BA3A9 0%, #7A8489 100%); }\n' +
                    '::-webkit-scrollbar-corner { background: #1A1D1F; }\n' +
                    '* { scrollbar-color: #4A5459 #1A1D1F; scrollbar-width: thin; }\n';
                doc.head.appendChild(style);

                // Fix jump links: scroll inside iframe, not parent
                doc.addEventListener('click', function(e) {
                    var link = e.target.closest ? e.target.closest('a[href^="#"]') : null;
                    if (!link) return;
                    var hash = link.getAttribute('href');
                    if (!hash || hash === '#') return;
                    var target = doc.querySelector(hash);
                    if (target) {
                        e.preventDefault();
                        target.scrollIntoView({ behavior: 'smooth' });
                    }
                });
            } catch (err) {
                // Cross-origin iframe — cannot inject styles
            }
        });
    }

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
        injectIframeTheme(iframe);

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

    /**
     * Check if a profile is a built-in page floor (page field points to
     * frontend/pages/* or is a bare name without slashes/URLs).
     * External URLs (http:/https:) and absolute/~ paths outside frontend/pages
     * are NOT considered built-in.
     */
    function isBuiltinPage(profile) {
        if (!profile.page) return false;
        var page = profile.page;
        // External URLs are not built-in
        if (/^https?:\/\//.test(page)) return false;
        // Absolute or ~-prefixed paths: only built-in if under frontend/pages/
        if (page.charAt(0) === '/' || page.charAt(0) === '~') {
            return page.indexOf('frontend/pages/') !== -1;
        }
        // Bare names (no slashes) are built-in page references
        return true;
    }

    /**
     * Get all enabled profiles that are built-in pages, for the pages hub.
     */
    function getBuiltinPageProfiles() {
        return profiles.filter(function(p) {
            return p.enabled !== false && isBuiltinPage(p);
        });
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
        injectIframeTheme(iframe);
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
                    TextViewer.captureTerminalText(floorId, contentDiv);
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
                    TextViewer.captureTerminalText(floorId, contentDiv2);
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

    // EDIT MODE — extracted to floor-edit.js (FloorEdit)

    // Context object for FloorEdit callbacks
    function getEditCtx() {
        return {
            profiles: profiles,
            defaultCwd: defaultCwd,
            findProfile: findProfile,
            findProfileIndex: findProfileIndex
        };
    }

    function enterEditMode(floorId) {
        FloorEdit.enterEditMode(floorId);
    }

    function exitEditMode(floorId) {
        FloorEdit.exitEditMode(floorId, getEditCtx());
    }

    function saveProfile(floorId) {
        FloorEdit.saveProfile(floorId, getEditCtx());
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
                if (profile.panel && PanelManager.getPanelState(floorId)) {
                    var content = document.getElementById('panel-content-' + floorId);
                    if (content && !content.hasChildNodes()) {
                        MarkdownPanel.load(content, profile.panel);
                    }
                }
            }
        });
    }

    // Recent dirs, workdir editor, and profile management are in lobby.js (LobbyManager)

    function initLobbyRefresh() {
        var btn = document.getElementById('lobby-refresh-btn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            ElevatorSounds.playClick();
            window.location.reload();
        });

        var hardBtn = document.getElementById('lobby-hard-refresh-btn');
        if (!hardBtn) return;
        hardBtn.addEventListener('click', function() {
            ElevatorSounds.playClick();
            // Unregister service workers, clear caches, then reload
            var tasks = [];
            if ('serviceWorker' in navigator) {
                tasks.push(
                    navigator.serviceWorker.getRegistrations().then(function(regs) {
                        return Promise.all(regs.map(function(r) { return r.unregister(); }));
                    })
                );
            }
            if ('caches' in window) {
                tasks.push(
                    caches.keys().then(function(names) {
                        return Promise.all(names.map(function(n) { return caches.delete(n); }));
                    })
                );
            }
            Promise.all(tasks).then(function() {
                window.location.reload();
            });
        });
    }

    function initLobbyShutdown() {
        var btn = document.getElementById('lobby-shutdown-btn');
        if (!btn) return;
        btn.addEventListener('click', function() {
            if (!confirm('Shut down CodeFactory backend?')) return;
            ElevatorSounds.playClick();
            fetch('/api/shutdown', { method: 'POST' }).catch(function() {});
            btn.textContent = '[SHUTTING DOWN...]';
            btn.disabled = true;
        });
    }

    // -- Mobile media query (shared with other modules) --
    var mobileMediaQuery = window.matchMedia('(max-width: 768px)');

    // -- MobileManager initialization (deferred until after helpers are defined) --
    function initMobileManager() {
        MobileManager.init({
            mobileMediaQuery: mobileMediaQuery,
            getCurrentFloor: function() { return currentFloor; },
            setCurrentFloor: function(id) { currentFloor = id; },
            getJumpTarget: function() { return jumpTarget; },
            setJumpTarget: function(id) { jumpTarget = id; },
            getFloorCount: function() { return floorCount; },
            floorsContainer: floorsContainer,
            elevatorButtons: elevatorButtons,
            floorLabels: floorLabels,
            floorRank: floorRank,
            floorRatios: floorRatios,
            getActiveFloorObserver: function() { return activeFloorObserver; },
            getBuiltinPageProfiles: getBuiltinPageProfiles,
            findProfile: findProfile,
            resolvePanelUrl: resolvePanelUrl,
            injectIframeTheme: injectIframeTheme,
            escapeHtml: escapeHtml,
            escapeAttr: escapeAttr,
            getDefaultCwd: function() { return defaultCwd; }
        });
    }

    // ==============================================================
    // ELEVATOR MECHANICS (initialized after floors render)
    // ==============================================================
    function initElevatorMechanics() {
        // Scroll to bottom on load (start at lobby)
        window.scrollTo(0, document.body.scrollHeight);

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

        // -- IntersectionObserver for active floor detection --
        // Reset intersection ratios for fresh observer
        floorRatios = {};

        activeFloorObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                floorRatios[entry.target.id] = entry.intersectionRatio;
            });

            // Skip updates during viewport resizes (keyboard) or mobile jump animations
            if (resizeGuard) return;
            if (jumpTarget && mobileMediaQuery.matches) return;

            // Find the floor with the highest intersection ratio
            var bestFloor = null;
            var bestRatio = -1;
            var keys = Object.keys(floorRatios);
            for (var k = 0; k < keys.length; k++) {
                if (floorRatios[keys[k]] > bestRatio) {
                    bestRatio = floorRatios[keys[k]];
                    bestFloor = keys[k];
                }
            }

            if (bestFloor && bestFloor !== currentFloor) {
                onFloorChanged(bestFloor);
            }
        }, { threshold: [0, 0.25, 0.5, 0.75, 1.0] });

        // Observe all floor elements (including lobby)
        floors.forEach(function (floor) {
            activeFloorObserver.observe(floor);
        });
        var lobbyEl = document.getElementById('lobby');
        if (lobbyEl) {
            activeFloorObserver.observe(lobbyEl);
        }

        // Door animation scroll handler (desktop only — doors are hidden on mobile)
        var doorTicking = false;
        window.addEventListener('scroll', function () {
            if (mobileMediaQuery.matches) return;
            if (!doorTicking) {
                requestAnimationFrame(updateDoorAnimations);
                doorTicking = true;
            }
        });

        function updateDoorAnimations() {
            doorTicking = false;
            var vh = window.innerHeight;
            floors.forEach(function (floor) {
                var rect = floor.getBoundingClientRect();
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
        }

        // Respond to a floor change (called by IntersectionObserver)
        function onFloorChanged(bestFloor) {
            var isMobile = mobileMediaQuery.matches;
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
                ElevatorSounds.playDing();
                // Focus terminal only on explicit jump (button/keyboard), not manual scroll
                if (wasJump) {
                    var floorNum = bestFloor.replace('floor-', '');
                    if (floorNum !== 'lobby' && floorNum !== 'pages-hub') {
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
            MobileManager.syncMobileBar();
        }

        // Button clicks — delegated so they survive DOM rebuilds
        document.querySelector('.panel-frame').addEventListener('click', function (e) {
            var btn = e.target.closest('.floor-btn');
            if (!btn) return;
            ElevatorSounds.playClick();
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
            if (e.key === 'Escape' && FloorEdit.getEditingFloor()) {
                exitEditMode(FloorEdit.getEditingFloor());
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
                    ElevatorSounds.playClick();
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
                // Debounce the entire handler — keyboard animation fires
                // 10-20 resize events; collapse into a single layout pass.
                resizeGuard = true;
                clearTimeout(vvTick);
                vvTick = setTimeout(function() {
                    var vh = window.visualViewport.height;
                    document.documentElement.style.setProperty('--vvh', vh + 'px');
                    refitAllTerminals();
                    var el = document.getElementById(currentFloor);
                    if (el) {
                        el.scrollIntoView({ behavior: 'instant', block: 'start' });
                    }
                    resizeGuard = false;
                }, 150);
            }
            window.visualViewport.addEventListener('resize', updateVisualViewport);
            // Set initial value (synchronous, no debounce needed)
            var initVh = window.visualViewport.height;
            document.documentElement.style.setProperty('--vvh', initVh + 'px');
        }

        // Initial door animation (IntersectionObserver fires automatically for floor detection)
        if (!mobileMediaQuery.matches) {
            updateDoorAnimations();
        }
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

    // ==============================================================
    // SLUG GENERATION (mirrors backend logic)
    // ==============================================================
    function slugify(name) {
        return name.toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .split('-')
            .filter(function(s) { return s.length > 0; })
            .join('-');
    }

    // ==============================================================
    // TRANSIENT FLOOR DUPLICATION
    // ==============================================================

    /**
     * Duplicate a floor as a transient (in-memory-only) clone.
     * The temp floor inherits default_cwd (via cwd: null), gets a unique
     * suffixed name like "Claude (2)", and is NOT saved to profiles.json.
     */
    function duplicateFloor(sourceFloorId) {
        var source = findProfile(sourceFloorId);
        if (!source || source.page) return;  // only duplicate terminal floors

        // Find the next available suffix for this source name
        var baseName = source.name.replace(/\s*\(\d+\)$/, '');  // strip existing "(N)" suffix
        var suffix = 2;
        var existingNames = profiles.map(function(p) { return p.name; });
        while (existingNames.indexOf(baseName + ' (' + suffix + ')') !== -1) {
            suffix++;
        }
        var newName = baseName + ' (' + suffix + ')';
        var newId = slugify(newName);

        // Ensure unique ID
        while (findProfile(newId)) {
            suffix++;
            newName = baseName + ' (' + suffix + ')';
            newId = slugify(newName);
        }

        var tempProfile = {
            id: newId,
            name: newName,
            command: source.command || null,
            cwd: null,  // inherit default_cwd at spawn time
            icon: source.icon || null,
            panel: source.panel || null,
            page: null,
            enabled: true,
            _temp: true
        };

        // Add to profiles array (but NOT persisted)
        profiles.push(tempProfile);

        // Re-render everything
        renderFloors(profiles);

        // Navigate to the new floor
        var targetEl = document.getElementById('floor-' + newId);
        if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth' });
        }

        // Auto power-on the new temp floor
        setTimeout(function() {
            var resolved = Object.assign({}, tempProfile, {
                cwd: defaultCwd || null
            });
            CodeFactoryTerminals.powerOn(newId, resolved);
            setTimeout(function() {
                CodeFactoryTerminals.focus(newId);
                MobileManager.syncMobileBar();
            }, 200);
        }, 300);

        console.log('[CodeFactory] Duplicated floor ' + sourceFloorId + ' -> ' + newId + ' (transient)');
    }

    /**
     * Remove a transient temp floor from the profiles array and DOM.
     * Called after killing a temp floor's terminal session.
     */
    function removeTempFloor(floorId) {
        var idx = findProfileIndex(floorId);
        if (idx === -1) return;

        // Remove from profiles array
        profiles.splice(idx, 1);

        // Re-render to clean up DOM
        renderFloors(profiles);

        // Scroll to lobby after removing
        var lobby = document.getElementById('lobby');
        if (lobby) {
            lobby.scrollIntoView({ behavior: 'smooth' });
        }

        console.log('[CodeFactory] Removed temp floor: ' + floorId);
    }

})();
