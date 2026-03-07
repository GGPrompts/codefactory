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
            setupMobileBar();
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
                            syncMobileBar();
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
                    // If this was a temp floor, remove it from profiles and DOM
                    if (profile && profile._temp) {
                        setTimeout(function() {
                            removeTempFloor(floorId);
                        }, 100);
                    }
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

    // ==============================================================
    // UNIFIED MOBILE BAR (swipeable keys + nav)
    // ==============================================================
    var mobileBar = null;
    var mobileBarTrack = null;
    var mobileBarDots = null;
    var mobileBarPanel = 0;          // 0 = keys, 1 = nav
    var mobileBarUserOverride = false; // user swiped manually
    var mobileMediaQuery = window.matchMedia('(max-width: 768px)');
    var pagesHubEl = null;           // pages hub floor section (mobile only)
    var pagesHubActiveTab = null;    // currently active tab profile id

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

            var chatRow = document.createElement('div');
            chatRow.className = 'mobile-bar-chat-form';

            var chatInput = document.createElement('div');
            chatInput.className = 'mobile-bar-chat-input';
            chatInput.setAttribute('contenteditable', 'true');
            chatInput.setAttribute('role', 'textbox');
            chatInput.spellcheck = false;
            chatInput.setAttribute('autocorrect', 'off');
            chatInput.setAttribute('autocapitalize', 'off');
            chatInput.setAttribute('enterkeyhint', 'send');

            // Prevent swipe detection when interacting with input
            chatInput.addEventListener('touchstart', function(e) {
                e.stopPropagation();
            }, { passive: true });

            // Enter key sends (without shift)
            chatInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendChatInput();
                }
            });

            var chatSend = document.createElement('button');
            chatSend.type = 'button';
            chatSend.className = 'mobile-bar-chat-send';

            // Icons
            var ICON_SEND = '\u25B6';   // ▶
            var ICON_MIC = '\uD83C\uDF99';  // 🎙
            var ICON_MIC_ON = '\uD83D\uDD34'; // 🔴

            // Speech recognition state
            var speechRecognition = null;
            var isListening = false;
            var hasSpeechAPI = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

            function updateSendButton() {
                var hasText = !!(chatInput.textContent || '').trim();
                if (hasText) {
                    chatSend.textContent = ICON_SEND;
                    chatSend.title = 'Send';
                } else if (isListening) {
                    chatSend.textContent = ICON_MIC_ON;
                    chatSend.title = 'Stop listening';
                    chatSend.classList.add('listening');
                } else if (hasSpeechAPI) {
                    chatSend.textContent = ICON_MIC;
                    chatSend.title = 'Voice input';
                    chatSend.classList.remove('listening');
                } else {
                    chatSend.textContent = ICON_SEND;
                    chatSend.title = 'Send';
                }
            }

            // Watch for input changes to toggle icon
            chatInput.addEventListener('input', updateSendButton);

            function startSpeechRecognition() {
                var SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechAPI) return;

                speechRecognition = new SpeechAPI();
                speechRecognition.continuous = false;
                speechRecognition.interimResults = true;
                speechRecognition.lang = 'en-US';

                var finalTranscript = '';

                speechRecognition.onresult = function(event) {
                    var interim = '';
                    for (var i = event.resultIndex; i < event.results.length; i++) {
                        if (event.results[i].isFinal) {
                            finalTranscript += event.results[i][0].transcript;
                        } else {
                            interim += event.results[i][0].transcript;
                        }
                    }
                    chatInput.textContent = finalTranscript + interim;
                };

                speechRecognition.onend = function() {
                    isListening = false;
                    speechRecognition = null;
                    // Trim and update button state
                    chatInput.textContent = (chatInput.textContent || '').trim();
                    updateSendButton();
                    // Re-focus terminal so keyboard comes back
                    var floorId = currentFloor ? currentFloor.replace('floor-', '') : null;
                    if (floorId && floorId !== 'lobby' && typeof ExtraKeys !== 'undefined' && ExtraKeys.isTerminalFloor(currentFloor)) {
                        CodeFactoryTerminals.focus(floorId);
                    }
                };

                speechRecognition.onerror = function(event) {
                    console.warn('[Chat] Speech recognition error:', event.error);
                    isListening = false;
                    speechRecognition = null;
                    updateSendButton();
                };

                isListening = true;
                finalTranscript = '';
                updateSendButton();
                try {
                    speechRecognition.start();
                } catch (err) {
                    console.warn('[Chat] Speech recognition failed to start:', err);
                    isListening = false;
                    speechRecognition = null;
                    updateSendButton();
                }
            }

            function stopSpeechRecognition() {
                if (speechRecognition) {
                    speechRecognition.stop();
                }
            }

            function sendChatInput() {
                var text = (chatInput.textContent || '').trim();
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

                chatInput.textContent = '';
                updateSendButton();
            }

            function handleSendOrMic() {
                var hasText = !!(chatInput.textContent || '').trim();
                if (hasText) {
                    sendChatInput();
                } else if (isListening) {
                    stopSpeechRecognition();
                } else if (hasSpeechAPI) {
                    startSpeechRecognition();
                }
            }

            chatSend.addEventListener('touchstart', function(e) {
                e.preventDefault();
                e.stopPropagation();
                handleSendOrMic();
            }, { passive: false });

            chatSend.addEventListener('click', function(e) {
                e.preventDefault();
                handleSendOrMic();
            });

            updateSendButton();

            var chatNavLeft = document.createElement('button');
            chatNavLeft.className = 'mobile-bar-panel-nav';
            chatNavLeft.setAttribute('data-bar-panel', '0');
            chatNavLeft.textContent = '\u2039'; // ‹

            var chatNavRight = document.createElement('button');
            chatNavRight.className = 'mobile-bar-panel-nav';
            chatNavRight.setAttribute('data-bar-panel', '2');
            chatNavRight.textContent = '\u203A'; // ›

            chatRow.appendChild(chatInput);
            chatRow.appendChild(chatSend);
            chatPanel.appendChild(chatNavLeft);
            chatPanel.appendChild(chatRow);
            chatPanel.appendChild(chatNavRight);
            mobileBarTrack.appendChild(chatPanel);

            // Panel 2: Elevator nav
            var navPanel = document.createElement('div');
            navPanel.className = 'mobile-bar-panel mobile-bar-nav';

            var navInner = document.createElement('div');
            navInner.className = 'mobile-bar-nav-inner';

            // Nav-to-chat button
            var navNavLeft = document.createElement('button');
            navNavLeft.className = 'mobile-bar-panel-nav';
            navNavLeft.setAttribute('data-bar-panel', '1');
            navNavLeft.textContent = '\u2039'; // ‹
            navInner.appendChild(navNavLeft);

            // Floor buttons (lowest first) — skip built-in pages on mobile
            var builtinPages = getBuiltinPageProfiles();
            var builtinFloorIds = {};
            builtinPages.forEach(function(p) {
                builtinFloorIds['floor-' + p.id] = true;
            });
            var hasHub = builtinPages.length > 0;

            // Lobby button
            var lobbyBtn = document.createElement('button');
            lobbyBtn.className = 'mobile-bar-btn';
            lobbyBtn.setAttribute('data-target', 'lobby');
            lobbyBtn.setAttribute('data-label', 'Lobby');
            lobbyBtn.textContent = 'L';
            if (currentFloor === 'lobby') lobbyBtn.classList.add('active');
            navInner.appendChild(lobbyBtn);

            // Pages hub button right after lobby (matches DOM order)
            if (hasHub) {
                var hubBtn = document.createElement('button');
                hubBtn.className = 'mobile-bar-btn mobile-bar-btn-hub';
                hubBtn.setAttribute('data-target', 'floor-pages-hub');
                hubBtn.setAttribute('data-label', 'Pages');
                hubBtn.textContent = '\uD83D\uDCC4'; // 📄
                if (currentFloor === 'floor-pages-hub') hubBtn.classList.add('active');
                navInner.appendChild(hubBtn);
            }

            var desktopBtns = elevatorButtons.querySelectorAll('.floor-btn');
            for (var i = desktopBtns.length - 1; i >= 0; i--) {
                var srcBtn = desktopBtns[i];
                // Skip built-in page floors — they go in the hub
                if (builtinFloorIds[srcBtn.dataset.target]) continue;
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
                        ElevatorSounds.playClick();
                        var targetId = mbtn.dataset.target;
                        var target = document.getElementById(targetId);
                        if (target) {
                            jumpTarget = targetId;
                            target.scrollIntoView({ behavior: 'instant', block: 'start' });
                            currentFloor = targetId;
                            syncMobileBar();
                            // Clear jumpTarget after observer settles so it doesn't
                            // immediately override currentFloor with a neighboring floor
                            setTimeout(function() { jumpTarget = null; }, 200);
                            var floorNum = targetId.replace('floor-', '');
                            if (floorNum !== 'lobby' && floorNum !== 'pages-hub') {
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

            // Panel-nav button handler (shared by touch and click)
            function handlePanelNav(target) {
                if (!target.classList.contains('mobile-bar-panel-nav') || !target.dataset.barPanel) return false;
                var panelIndex = parseInt(target.dataset.barPanel, 10);
                mobileBarUserOverride = true;
                setBarPanel(panelIndex);
                // Re-focus terminal only when switching to extra keys panel (0)
                // so the soft keyboard stays up for key input. Other panels
                // don't need terminal focus and forcing it causes keyboard flicker.
                if (panelIndex === 0) {
                    var floorId = currentFloor ? currentFloor.replace('floor-', '') : null;
                    if (floorId && floorId !== 'lobby' && typeof ExtraKeys !== 'undefined' && ExtraKeys.isTerminalFloor(currentFloor)) {
                        CodeFactoryTerminals.focus(floorId);
                    }
                }
                return true;
            }

            // Touchstart: preventDefault keeps keyboard open, also switch panel
            // immediately since preventDefault blocks the subsequent click event
            mobileBar.addEventListener('touchstart', function(e) {
                var target = e.target;
                if (target.classList.contains('mobile-bar-panel-nav')) {
                    e.preventDefault();  // prevent focus loss (keeps soft keyboard open)
                    e.stopPropagation(); // prevent swipe gesture
                    handlePanelNav(target);
                }
            }, { passive: false });

            // Click fallback for non-touch (e.g. Phone Link mouse clicks)
            mobileBar.addEventListener('click', function(e) {
                var target = e.target;
                if (target.classList.contains('mobile-bar-panel-nav')) {
                    e.preventDefault();
                    e.stopPropagation();
                    handlePanelNav(target);
                }
            });

            document.body.appendChild(mobileBar);

            // Create pages hub floor (mobile only)
            if (hasHub) {
                createPagesHub(builtinPages);
            }

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
            removePagesHub();
        }
    }

    // ==============================================================
    // PAGES HUB (mobile-only consolidated page floor)
    // ==============================================================
    function createPagesHub(builtinPages) {
        removePagesHub(); // clean up any existing hub

        pagesHubEl = document.createElement('section');
        pagesHubEl.className = 'floor powered-on pages-hub-floor in-view';
        pagesHubEl.id = 'floor-pages-hub';

        var html = '' +
            '<div class="floor-frame">' +
                '<div class="pages-hub-tabbar">';

        for (var i = 0; i < builtinPages.length; i++) {
            var p = builtinPages[i];
            var tabIcon = p.icon ? escapeHtml(p.icon) + ' ' : '';
            var tabName = escapeHtml(p.name || p.id);
            var activeClass = (i === 0) ? ' active' : '';
            html += '<button class="pages-hub-tab' + activeClass + '" data-hub-page-id="' + escapeAttr(p.id) + '">' +
                        tabIcon + tabName +
                    '</button>';
        }

        html += '</div>' +
                '<div class="pages-hub-content" id="pages-hub-content"></div>' +
            '</div>';

        pagesHubEl.innerHTML = html;

        // Insert before lobby so it sits at the bottom of the floors
        var lobbyEl = document.getElementById('lobby');
        if (lobbyEl) {
            lobbyEl.parentNode.insertBefore(pagesHubEl, lobbyEl);
        } else {
            floorsContainer.appendChild(pagesHubEl);
        }

        // Register in floor tracking
        floorLabels['floor-pages-hub'] = '\uD83D\uDCC4';
        floorRank['floor-pages-hub'] = 0.5; // between lobby and first floor

        // Observe for active floor detection
        if (activeFloorObserver) {
            activeFloorObserver.observe(pagesHubEl);
        }

        // Attach tab click handlers
        var tabs = pagesHubEl.querySelectorAll('.pages-hub-tab');
        for (var j = 0; j < tabs.length; j++) {
            tabs[j].addEventListener('click', (function(tab) {
                return function() {
                    var pageId = tab.getAttribute('data-hub-page-id');
                    activateHubTab(pageId);
                };
            })(tabs[j]));
        }

        // Auto-load first tab
        if (builtinPages.length > 0) {
            activateHubTab(builtinPages[0].id);
        }
    }

    function removePagesHub() {
        if (pagesHubEl) {
            if (activeFloorObserver) {
                activeFloorObserver.unobserve(pagesHubEl);
            }
            pagesHubEl.remove();
            pagesHubEl = null;
            pagesHubActiveTab = null;
            delete floorLabels['floor-pages-hub'];
            delete floorRank['floor-pages-hub'];
            delete floorRatios['floor-pages-hub'];
        }
    }

    function activateHubTab(pageId) {
        if (!pagesHubEl) return;
        var profile = findProfile(pageId);
        if (!profile) return;

        pagesHubActiveTab = pageId;

        // Update tab active state
        var tabs = pagesHubEl.querySelectorAll('.pages-hub-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('active', tabs[i].getAttribute('data-hub-page-id') === pageId);
        }

        // Swap iframe
        var container = document.getElementById('pages-hub-content');
        if (!container) return;

        var pageUrl = resolvePanelUrl(profile.page);
        var pageCwd = profile.cwd || defaultCwd || '';
        if (pageCwd) {
            pageUrl += (pageUrl.indexOf('?') === -1 ? '?' : '&') + 'path=' + encodeURIComponent(pageCwd);
        }

        // If already showing this page, reload the iframe
        var existing = container.querySelector('iframe');
        if (existing && existing.getAttribute('data-hub-page-id') === pageId) {
            existing.contentWindow.location.reload();
            return;
        }

        container.innerHTML = '';
        var iframe = document.createElement('iframe');
        iframe.className = 'pages-hub-iframe';
        iframe.src = pageUrl;
        iframe.setAttribute('data-hub-page-id', pageId);
        iframe.setAttribute('frameborder', '0');
        container.appendChild(iframe);
        injectIframeTheme(iframe);

        console.log('[PagesHub] Activated tab: ' + profile.name + ' (' + profile.page + ')');
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

        // Reset nav scroll to the start (L button) so the list is predictable
        var navInner = mobileBar.querySelector('.mobile-bar-nav-inner');
        if (navInner) {
            navInner.scrollLeft = 0;
        }

        // Update extra keys floor
        if (typeof ExtraKeys !== 'undefined') {
            ExtraKeys.setFloor(currentFloor);
        }

        // Auto-switch panel only on first load; once the user manually
        // swipes to a panel it stays put across floor changes.
        if (!mobileBarUserOverride) {
            autoSelectPanel();
        }
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
            syncMobileBar();
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
                syncMobileBar();
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
