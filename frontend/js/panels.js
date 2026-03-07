/**
 * PanelManager — panel state (localStorage) + toggle & resize logic.
 * Extracted from app.js IIFE.
 *
 * Globals used:
 *   - MarkdownPanel.load()          (markdown-panel.js)
 *   - CodeFactoryTerminals          (terminal.js)
 *
 * Exposed as window.PanelManager
 */
var PanelManager = (function () {
    'use strict';

    // ------------------------------------------------------------------
    // PANEL STATE (localStorage)
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // PANEL TOGGLE & RESIZE
    // ------------------------------------------------------------------

    /**
     * Refit the xterm terminal after a panel open/close/resize.
     */
    function refitTerminal(floorId) {
        setTimeout(function () {
            if (typeof CodeFactoryTerminals === 'undefined') return;
            var entry = CodeFactoryTerminals.getTerminal(floorId);
            if (entry && entry.fitAddon && entry.powered) {
                entry.fitAddon.fit();
            }
        }, 350);  // wait for CSS transition
    }

    /**
     * Toggle the side panel open/closed.
     *
     * @param {string}      floorId
     * @param {string}      panelName   – markdown panel identifier
     * @param {HTMLElement}  btn         – the [PANEL] button element
     * @param {object}       callbacks   – { activePanelTab, updatePanelTabs }
     */
    function togglePanel(floorId, panelName, btn, callbacks) {
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
            if (callbacks && callbacks.activePanelTab) {
                callbacks.activePanelTab[floorId] = 'reference';
            }
            if (callbacks && callbacks.updatePanelTabs) {
                callbacks.updatePanelTabs(floorId);
            }

            // Load content if not yet loaded
            var content = document.getElementById('panel-content-' + floorId);
            if (content && !content.hasChildNodes()) {
                MarkdownPanel.load(content, panelName);
            } else if (callbacks && callbacks.activePanelTab &&
                       callbacks.activePanelTab[floorId] === 'reference') {
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

    /**
     * Attach drag-to-resize behaviour to a panel resize handle.
     */
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

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    return {
        getPanelState: getPanelState,
        setPanelState: setPanelState,
        getPanelWidth: getPanelWidth,
        setPanelWidth: setPanelWidth,
        togglePanel: togglePanel,
        initPanelResize: initPanelResize,
        refitTerminal: refitTerminal
    };
})();
