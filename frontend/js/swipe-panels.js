/* ==============================================================
   CodeFactory -- Swipe Panel System
   Edge-based panels revealed by swipe gestures (mobile) or
   pinned open on desktop. Four slots: left, right, top, bottom.
   ============================================================== */
var SwipePanels = (function () {
    'use strict';

    // -- Configuration --
    var SWIPE_THRESHOLD = 50;      // minimum px to trigger a swipe
    var SWIPE_MAX_CROSS  = 80;     // max perpendicular drift before cancel
    var EDGE_ZONE        = 50;     // px from edge where swipe-to-open starts
    var TRANSITION_MS    = 300;    // CSS transition duration

    // -- Valid edges --
    var EDGES = ['left', 'right', 'top', 'bottom'];

    // -- State --
    var panels = {};       // edge -> { el: HTMLElement, pinned: false }
    var openEdge = null;   // currently open edge (only one at a time)
    var touchData = null;  // active touch tracking

    // -- DOM refs (created once) --
    var backdrop = null;
    var container = null;

    // ==============================================================
    // INITIALISATION
    // ==============================================================
    function init() {
        container = document.getElementById('swipe-panels');
        if (!container) {
            container = document.createElement('div');
            container.id = 'swipe-panels';
            document.body.appendChild(container);
        }

        // Build panel slots
        EDGES.forEach(function (edge) {
            var slot = container.querySelector('.swipe-panel[data-edge="' + edge + '"]');
            if (!slot) {
                slot = document.createElement('div');
                slot.className = 'swipe-panel swipe-panel--' + edge;
                slot.setAttribute('data-edge', edge);
                container.appendChild(slot);
            }
            panels[edge] = { el: slot, pinned: false };
        });

        // Backdrop
        backdrop = container.querySelector('.swipe-panel-backdrop');
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.className = 'swipe-panel-backdrop';
            container.appendChild(backdrop);
        }
        backdrop.addEventListener('click', function () {
            if (openEdge) { hidePanel(openEdge); }
        });

        // Touch listeners on document (passive where possible)
        document.addEventListener('touchstart', onTouchStart, { passive: true });
        document.addEventListener('touchmove', onTouchMove, { passive: true });
        document.addEventListener('touchend', onTouchEnd, { passive: true });

        // Keyboard: Escape closes open panel
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && openEdge && !panels[openEdge].pinned) {
                hidePanel(openEdge);
            }
        });
    }

    // ==============================================================
    // TOUCH HANDLING
    // ==============================================================
    function onTouchStart(e) {
        if (e.touches.length !== 1) return;
        var touch = e.touches[0];
        // Check if touch started inside an open panel's content
        var insidePanel = false;
        if (openEdge && panels[openEdge]) {
            insidePanel = panels[openEdge].el.contains(e.target);
        }
        touchData = {
            startX: touch.clientX,
            startY: touch.clientY,
            startTime: Date.now(),
            startEdge: detectEdgeZone(touch.clientX, touch.clientY),
            moved: false,
            insidePanel: insidePanel
        };
    }

    function onTouchMove(e) {
        if (!touchData || e.touches.length !== 1) return;
        touchData.moved = true;
    }

    function onTouchEnd(e) {
        if (!touchData) return;
        if (!touchData.moved) { touchData = null; return; }

        var touch = e.changedTouches[0];
        var dx = touch.clientX - touchData.startX;
        var dy = touch.clientY - touchData.startY;
        var absDx = Math.abs(dx);
        var absDy = Math.abs(dy);

        // Determine dominant axis
        var horizontal = absDx > absDy;
        var dominant = horizontal ? absDx : absDy;
        var cross = horizontal ? absDy : absDx;

        // Must exceed threshold and not drift too much on cross-axis
        if (dominant < SWIPE_THRESHOLD || cross > SWIPE_MAX_CROSS) {
            touchData = null;
            return;
        }

        var direction;
        if (horizontal) {
            direction = dx > 0 ? 'right' : 'left';
        } else {
            direction = dy > 0 ? 'down' : 'up';
        }

        handleSwipe(direction, touchData.startEdge, touchData.insidePanel);
        touchData = null;
    }

    function detectEdgeZone(x, y) {
        var w = window.innerWidth;
        var h = window.innerHeight;
        if (x <= EDGE_ZONE) return 'left';
        if (x >= w - EDGE_ZONE) return 'right';
        if (y <= EDGE_ZONE) return 'top';
        if (y >= h - EDGE_ZONE) return 'bottom';
        return null;
    }

    // ==============================================================
    // SWIPE LOGIC
    // ==============================================================
    function handleSwipe(direction, startEdge, insidePanel) {
        // If a panel is open, swiping in the panel's own direction closes it
        // But NOT if the swipe started inside the panel (user is scrolling content)
        if (openEdge) {
            var shouldClose = false;
            if (openEdge === 'left' && direction === 'left') shouldClose = true;
            if (openEdge === 'right' && direction === 'right') shouldClose = true;
            if (openEdge === 'top' && direction === 'up') shouldClose = true;
            if (openEdge === 'bottom' && direction === 'down') shouldClose = true;

            if (shouldClose && !panels[openEdge].pinned && !insidePanel) {
                hidePanel(openEdge);
                return;
            }
        }

        // Open panel: swipe from edge inward
        // Swiping right from left edge -> open left panel
        // Swiping left from right edge -> open right panel
        // Swiping down from top edge -> open top panel
        // Swiping up from bottom edge -> open bottom panel
        var target = null;
        if (direction === 'right' && startEdge === 'left') target = 'left';
        if (direction === 'left' && startEdge === 'right') target = 'right';
        if (direction === 'down' && startEdge === 'top') target = 'top';
        if (direction === 'up' && startEdge === 'bottom') target = 'bottom';

        if (target && panels[target] && panels[target].el.children.length > 0) {
            // Close any other open panel first
            if (openEdge && openEdge !== target) {
                hidePanel(openEdge);
            }
            showPanel(target);
        }
    }

    // ==============================================================
    // SHOW / HIDE / PIN
    // ==============================================================
    function showPanel(edge) {
        if (!panels[edge]) return;
        var p = panels[edge];
        if (p.el.children.length === 0) return; // no content registered

        p.el.classList.add('swipe-panel--open');
        backdrop.classList.add('swipe-panel-backdrop--visible');
        openEdge = edge;
    }

    function hidePanel(edge) {
        if (!panels[edge]) return;
        var p = panels[edge];
        if (p.pinned) return; // don't hide pinned panels

        p.el.classList.remove('swipe-panel--open');
        if (openEdge === edge) {
            openEdge = null;
            backdrop.classList.remove('swipe-panel-backdrop--visible');
        }
    }

    function hideAll() {
        EDGES.forEach(function (edge) {
            if (panels[edge] && !panels[edge].pinned) {
                panels[edge].el.classList.remove('swipe-panel--open');
            }
        });
        openEdge = null;
        backdrop.classList.remove('swipe-panel-backdrop--visible');
    }

    function togglePanel(edge) {
        if (!panels[edge]) return;
        if (openEdge === edge) {
            hidePanel(edge);
        } else {
            if (openEdge) hidePanel(openEdge);
            showPanel(edge);
        }
    }

    function pinPanel(edge, pinned) {
        if (!panels[edge]) return;
        panels[edge].pinned = pinned;
        panels[edge].el.classList.toggle('swipe-panel--pinned', pinned);
        if (pinned) {
            showPanel(edge);
            // When pinned, hide backdrop (panel stays open alongside content)
            backdrop.classList.remove('swipe-panel-backdrop--visible');
        }
    }

    function isPinned(edge) {
        return panels[edge] ? panels[edge].pinned : false;
    }

    function isOpen(edge) {
        return panels[edge] ? panels[edge].el.classList.contains('swipe-panel--open') : false;
    }

    // ==============================================================
    // PANEL REGISTRATION
    // ==============================================================
    /**
     * Register content in an edge panel slot.
     * @param {string} edge - 'left' | 'right' | 'top' | 'bottom'
     * @param {HTMLElement} contentElement - DOM element to place inside the panel
     */
    function registerPanel(edge, contentElement) {
        if (!panels[edge]) {
            console.warn('[SwipePanels] Invalid edge: ' + edge);
            return;
        }
        // Clear existing content
        panels[edge].el.innerHTML = '';
        panels[edge].el.appendChild(contentElement);
    }

    /**
     * Remove content from an edge panel.
     * @param {string} edge - 'left' | 'right' | 'top' | 'bottom'
     */
    function unregisterPanel(edge) {
        if (!panels[edge]) return;
        hidePanel(edge);
        panels[edge].el.innerHTML = '';
        panels[edge].pinned = false;
        panels[edge].el.classList.remove('swipe-panel--pinned');
    }

    /**
     * Get the panel container element for an edge (for direct DOM manipulation).
     * @param {string} edge
     * @returns {HTMLElement|null}
     */
    function getPanelElement(edge) {
        return panels[edge] ? panels[edge].el : null;
    }

    // ==============================================================
    // AUTO-INIT
    // ==============================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // -- Public API --
    return {
        registerPanel: registerPanel,
        unregisterPanel: unregisterPanel,
        showPanel: showPanel,
        hidePanel: hidePanel,
        hideAll: hideAll,
        togglePanel: togglePanel,
        pinPanel: pinPanel,
        isPinned: isPinned,
        isOpen: isOpen,
        getPanelElement: getPanelElement
    };
})();
