/* ==============================================================
   MobileManager -- Unified Mobile Bar & Pages Hub
   Extracted from app.js
   ============================================================== */
var MobileManager = (function () {
    'use strict';

    // -- Module state --
    var mobileBar = null;
    var mobileBarTrack = null;
    var mobileBarDots = null;
    var mobileBarPanel = 0;          // 0 = keys, 1 = chat, 2 = nav
    var mobileBarUserOverride = false; // user swiped manually
    var pagesHubEl = null;           // pages hub floor section (mobile only)
    var pagesHubActiveTab = null;    // currently active tab profile id

    // -- Context (set via init or passed per call) --
    var ctx = null;

    /**
     * Initialize the module with a context object providing access to
     * app.js state and helpers.
     *
     * Expected context properties:
     *   mobileMediaQuery    - MediaQueryList for mobile detection
     *   getCurrentFloor()   - returns current floor id string
     *   setCurrentFloor(id) - sets current floor id
     *   getJumpTarget()     - returns jumpTarget
     *   setJumpTarget(id)   - sets jumpTarget
     *   getFloorCount()     - returns number of enabled floors
     *   floorsContainer     - DOM element #floors-container
     *   elevatorButtons     - DOM element #elevator-buttons
     *   floorLabels         - object mapping floor id -> label
     *   floorRank           - object mapping floor id -> numeric rank
     *   floorRatios         - object mapping floor id -> intersectionRatio
     *   getActiveFloorObserver() - returns the activeFloorObserver
     *   getBuiltinPageProfiles() - returns array of built-in page profiles
     *   findProfile(id)     - finds a profile by floor id
     *   resolvePanelUrl(id) - resolves panel identifier to URL
     *   injectIframeTheme(iframe) - injects theme CSS into iframe
     *   escapeHtml(str)     - HTML-escapes a string
     *   escapeAttr(str)     - attribute-escapes a string
     *   getDefaultCwd()     - returns defaultCwd
     */
    function init(context) {
        ctx = context;

        // Listen for viewport changes
        ctx.mobileMediaQuery.addEventListener('change', function () {
            setupMobileBar();
        });
    }

    // ==============================================================
    // UNIFIED MOBILE BAR (swipeable keys + nav)
    // ==============================================================

    function setupMobileBar() {
        var isMobile = ctx.mobileMediaQuery.matches;
        var currentFloor = ctx.getCurrentFloor();
        var floorCount = ctx.getFloorCount();

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
                    var floorId = ctx.getCurrentFloor() ? ctx.getCurrentFloor().replace('floor-', '') : null;
                    if (floorId && floorId !== 'lobby' && typeof ExtraKeys !== 'undefined' && ExtraKeys.isTerminalFloor(ctx.getCurrentFloor())) {
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
                var floorId = ctx.getCurrentFloor() ? ctx.getCurrentFloor().replace('floor-', '') : null;
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
            var builtinPages = ctx.getBuiltinPageProfiles();
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

            var desktopBtns = ctx.elevatorButtons.querySelectorAll('.floor-btn');
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
                            ctx.setJumpTarget(targetId);
                            target.scrollIntoView({ behavior: 'instant', block: 'start' });
                            ctx.setCurrentFloor(targetId);
                            syncMobileBar();
                            // Clear jumpTarget after observer settles so it doesn't
                            // immediately override currentFloor with a neighboring floor
                            setTimeout(function() { ctx.setJumpTarget(null); }, 200);
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
                    var floorId = ctx.getCurrentFloor() ? ctx.getCurrentFloor().replace('floor-', '') : null;
                    if (floorId && floorId !== 'lobby' && typeof ExtraKeys !== 'undefined' && ExtraKeys.isTerminalFloor(ctx.getCurrentFloor())) {
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
            var tabIcon = p.icon ? ctx.escapeHtml(p.icon) + ' ' : '';
            var tabName = ctx.escapeHtml(p.name || p.id);
            var activeClass = (i === 0) ? ' active' : '';
            html += '<button class="pages-hub-tab' + activeClass + '" data-hub-page-id="' + ctx.escapeAttr(p.id) + '">' +
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
            ctx.floorsContainer.appendChild(pagesHubEl);
        }

        // Register in floor tracking
        ctx.floorLabels['floor-pages-hub'] = '\uD83D\uDCC4';
        ctx.floorRank['floor-pages-hub'] = 0.5; // between lobby and first floor

        // Observe for active floor detection
        var observer = ctx.getActiveFloorObserver();
        if (observer) {
            observer.observe(pagesHubEl);
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
            var observer = ctx.getActiveFloorObserver();
            if (observer) {
                observer.unobserve(pagesHubEl);
            }
            pagesHubEl.remove();
            pagesHubEl = null;
            pagesHubActiveTab = null;
            delete ctx.floorLabels['floor-pages-hub'];
            delete ctx.floorRank['floor-pages-hub'];
            delete ctx.floorRatios['floor-pages-hub'];
        }
    }

    function activateHubTab(pageId) {
        if (!pagesHubEl) return;
        var profile = ctx.findProfile(pageId);
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

        var pageUrl = ctx.resolvePanelUrl(profile.page);
        var pageCwd = profile.cwd || ctx.getDefaultCwd() || '';
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
        ctx.injectIframeTheme(iframe);

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
        if (typeof ExtraKeys !== 'undefined' && ExtraKeys.isTerminalFloor(ctx.getCurrentFloor())) {
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

        var currentFloor = ctx.getCurrentFloor();

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

    /**
     * Tear down the mobile bar DOM (used by renderFloors before re-setup).
     */
    function teardown() {
        if (mobileBar) {
            mobileBar.remove();
            mobileBar = null;
            mobileBarTrack = null;
            mobileBarDots = null;
        }
    }

    // -- Public API --
    return {
        init: init,
        setupMobileBar: setupMobileBar,
        syncMobileBar: syncMobileBar,
        setBarPanel: setBarPanel,
        autoSelectPanel: autoSelectPanel,
        createPagesHub: createPagesHub,
        activateHubTab: activateHubTab,
        teardown: teardown
    };
})();
