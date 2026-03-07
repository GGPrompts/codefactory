/**
 * TextViewer — terminal text view (eye button) + panel tab switching.
 * Extracted from app.js IIFE.
 *
 * Globals used:
 *   - PanelManager          (panels.js)
 *   - MarkdownPanel.load()  (markdown-panel.js)
 *   - SwipePanels           (swipe-panels.js)
 *
 * Exposed as window.TextViewer
 */
var TextViewer = (function () {
    'use strict';

    // Track which tab is active per floor: 'reference' or 'terminal'
    var activePanelTab = {};  // floorId -> 'reference' | 'terminal'

    /**
     * Open the terminal text view in the side panel.
     * On desktop: expands the side panel with captured text.
     * On mobile: opens the left swipe panel with captured text.
     *
     * @param {string}   floorId
     * @param {object}   ctx  – { mobileMediaQuery, clearFloorPanels, activeFloorPanelEdges, findProfile }
     */
    function openTerminalTextView(floorId, ctx) {
        var isMobile = ctx.mobileMediaQuery.matches;

        if (isMobile) {
            openTerminalTextMobile(floorId, ctx);
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
            PanelManager.refitTerminal(floorId);
            return;
        }

        // Expand panel if collapsed
        if (isCollapsed) {
            panel.classList.remove('collapsed');
            var savedWidth = PanelManager.getPanelWidth(floorId);
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

        PanelManager.refitTerminal(floorId);
    }

    function openTerminalTextMobile(floorId, ctx) {
        ctx.clearFloorPanels();

        var profile = ctx.findProfile(floorId);
        var hasRefPanel = !!(profile && profile.panel);

        var wrapper = document.createElement('div');
        wrapper.className = 'swipe-markdown-panel';

        // Close button for mobile full-screen panel
        var closeBtn = document.createElement('button');
        closeBtn.className = 'swipe-panel-close-btn';
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.title = 'Close panel';
        closeBtn.addEventListener('click', function() {
            SwipePanels.hidePanel('left');
        });

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
            tabBar.appendChild(closeBtn);
            wrapper.appendChild(tabBar);
        } else {
            var header = document.createElement('div');
            header.className = 'swipe-markdown-header';
            header.textContent = 'TERMINAL OUTPUT';
            header.style.position = 'relative';
            header.appendChild(closeBtn);
            wrapper.appendChild(header);
        }

        var contentDiv = document.createElement('div');
        contentDiv.className = 'swipe-markdown-content industrial-prose';
        wrapper.appendChild(contentDiv);

        SwipePanels.registerPanel('left', wrapper);
        ctx.activeFloorPanelEdges.push('left');

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
     *
     * @param {string}   floorId
     * @param {string}   tabName  – 'reference' or 'terminal'
     * @param {function} findProfile – callback to look up profile by floorId
     */
    function switchPanelTab(floorId, tabName, findProfile) {
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

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    return {
        activePanelTab: activePanelTab,
        openTerminalTextView: openTerminalTextView,
        updatePanelTabs: updatePanelTabs,
        switchPanelTab: switchPanelTab,
        captureTerminalText: captureTerminalText
    };
})();
