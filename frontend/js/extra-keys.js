/* ==============================================================
   ExtraKeys — Mobile extra keys bar (Termux-style)
   ============================================================== */
var ExtraKeys = (function () {
    'use strict';

    // -- Key definitions --
    // Row 1: modifiers + common symbols + arrows
    var ROW1 = [
        { label: 'ESC',  type: 'sequence', value: '\x1b' },
        { label: 'TAB',  type: 'text',     value: '\t' },
        { label: 'CTRL', type: 'modifier',  name: 'ctrl' },
        { label: 'ALT',  type: 'modifier',  name: 'alt' },
        { label: '/',    type: 'text',     value: '/' },
        { label: '|',    type: 'text',     value: '|' },
        { label: '\u2191', type: 'sequence', value: '\x1b[A' },
        { label: '\u2193', type: 'sequence', value: '\x1b[B' },
        { label: '\u2190', type: 'sequence', value: '\x1b[D' },
        { label: '\u2192', type: 'sequence', value: '\x1b[C' },
    ];

    // Row 2: function keys + navigation
    var ROW2 = [
        { label: 'F1',   type: 'sequence', value: '\x1bOP' },
        { label: 'F2',   type: 'sequence', value: '\x1bOQ' },
        { label: 'F3',   type: 'sequence', value: '\x1bOR' },
        { label: 'F4',   type: 'sequence', value: '\x1bOS' },
        { label: 'F5',   type: 'sequence', value: '\x1b[15~' },
        { label: 'F6',   type: 'sequence', value: '\x1b[17~' },
        { label: 'F7',   type: 'sequence', value: '\x1b[18~' },
        { label: 'F8',   type: 'sequence', value: '\x1b[19~' },
        { label: 'F9',   type: 'sequence', value: '\x1b[20~' },
        { label: 'F10',  type: 'sequence', value: '\x1b[21~' },
        { label: 'HOME', type: 'sequence', value: '\x1b[H' },
        { label: 'PGUP', type: 'sequence', value: '\x1b[5~' },
        { label: 'PGDN', type: 'sequence', value: '\x1b[6~' },
    ];

    // -- Modifier state --
    var modState = { ctrl: 'inactive', alt: 'inactive' };
    var modLastTap = { ctrl: 0, alt: 0 };
    var DOUBLE_TAP_MS = 400;

    // -- State --
    var bar = null;
    var currentFloorId = null;
    var initialized = false;

    // ==============================================================
    // DOM CREATION
    // ==============================================================
    function createBar() {
        var el = document.createElement('div');
        el.className = 'extra-keys-bar';

        el.appendChild(createRow(ROW1));
        el.appendChild(createRow(ROW2));

        return el;
    }

    function createRow(keys) {
        var row = document.createElement('div');
        row.className = 'extra-keys-row';

        for (var i = 0; i < keys.length; i++) {
            var keyDef = keys[i];
            var btn = document.createElement('button');
            btn.className = 'extra-key-btn';
            btn.textContent = keyDef.label;

            if (keyDef.type === 'modifier') {
                btn.setAttribute('data-mod', keyDef.name);
            }

            attachKeyListeners(btn, keyDef);
            row.appendChild(btn);
        }

        return row;
    }

    function attachKeyListeners(btn, keyDef) {
        // touchstart with preventDefault to avoid VK popup/dismiss
        btn.addEventListener('touchstart', function (e) {
            e.preventDefault();
            handleKeyTap(keyDef);
        }, { passive: false });

        // click for desktop testing (won't fire on mobile due to preventDefault)
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            handleKeyTap(keyDef);
        });
    }

    // ==============================================================
    // KEY HANDLING
    // ==============================================================
    function handleKeyTap(keyDef) {
        if (keyDef.type === 'modifier') {
            cycleModifier(keyDef.name);
            return;
        }

        var value = keyDef.value;
        value = applyModifiers(value);
        sendInput(value);
        consumeActiveModifiers();
    }

    function applyModifiers(value) {
        var ctrlOn = modState.ctrl === 'active' || modState.ctrl === 'locked';
        var altOn = modState.alt === 'active' || modState.alt === 'locked';

        if (ctrlOn) {
            value = applyCtrl(value);
        }
        if (altOn) {
            value = '\x1b' + value;
        }

        return value;
    }

    function applyCtrl(text) {
        if (text.length === 1) {
            var code = text.charCodeAt(0);
            // Letters a-z / A-Z -> \x01-\x1a
            if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
                return String.fromCharCode(code & 0x1f);
            }
            // Common ctrl combos: [ -> ESC, \ -> FS, ] -> GS
            if (code === 91) return '\x1b';
            if (code === 92) return '\x1c';
            if (code === 93) return '\x1d';
        }
        // Ctrl+arrow sequences
        if (text === '\x1b[A') return '\x1b[1;5A';
        if (text === '\x1b[B') return '\x1b[1;5B';
        if (text === '\x1b[C') return '\x1b[1;5C';
        if (text === '\x1b[D') return '\x1b[1;5D';
        return text;
    }

    // ==============================================================
    // STICKY MODIFIERS
    // ==============================================================
    function cycleModifier(name) {
        var now = Date.now();
        var timeSinceLast = now - modLastTap[name];
        modLastTap[name] = now;

        if (modState[name] === 'inactive') {
            if (timeSinceLast < DOUBLE_TAP_MS) {
                modState[name] = 'locked';
            } else {
                modState[name] = 'active';
            }
        } else if (modState[name] === 'active') {
            modState[name] = 'locked';
        } else {
            modState[name] = 'inactive';
        }
        updateModifierUI();
    }

    function consumeActiveModifiers() {
        var changed = false;
        ['ctrl', 'alt'].forEach(function (name) {
            if (modState[name] === 'active') {
                modState[name] = 'inactive';
                changed = true;
            }
        });
        if (changed) updateModifierUI();
    }

    function resetActiveModifiers() {
        ['ctrl', 'alt'].forEach(function (name) {
            if (modState[name] === 'active') {
                modState[name] = 'inactive';
            }
        });
        updateModifierUI();
    }

    function updateModifierUI() {
        if (!bar) return;
        var btns = bar.querySelectorAll('[data-mod]');
        for (var i = 0; i < btns.length; i++) {
            var name = btns[i].getAttribute('data-mod');
            var state = modState[name] || 'inactive';
            btns[i].classList.toggle('mod-active', state === 'active');
            btns[i].classList.toggle('mod-locked', state === 'locked');
        }
    }

    // ==============================================================
    // INPUT SENDING
    // ==============================================================
    function sendInput(value) {
        if (!currentFloorId) return;
        if (typeof CodeFactoryTerminals === 'undefined') return;

        var entry = CodeFactoryTerminals.getTerminal(currentFloorId);
        if (!entry || entry.inputGuarded || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) return;

        var encoded = btoa(unescape(encodeURIComponent(value)));
        entry.ws.send(JSON.stringify({ type: 'terminal-input', data: encoded }));

        // Keep terminal focused
        CodeFactoryTerminals.focus(currentFloorId);
    }

    // ==============================================================
    // VISIBILITY
    // ==============================================================
    function show() {
        if (!bar) return;
        bar.style.display = '';
        document.body.classList.add('extra-keys-visible');
    }

    function hide() {
        if (!bar) return;
        bar.style.display = 'none';
        document.body.classList.remove('extra-keys-visible');
    }

    function syncVisibility(currentFloor, isMobile) {
        if (!bar) return;
        if (!isMobile) {
            hide();
            return;
        }

        // Extract floor ID (strip 'floor-' prefix)
        var floorId = currentFloor ? currentFloor.replace('floor-', '') : '';

        // Hide for lobby
        if (!floorId || floorId === 'lobby') {
            hide();
            return;
        }

        // Hide for page floors
        var section = document.getElementById('floor-' + floorId);
        if (section && section.hasAttribute('data-page')) {
            hide();
            return;
        }

        // Hide if not powered on
        if (typeof CodeFactoryTerminals !== 'undefined') {
            var entry = CodeFactoryTerminals.getTerminal(floorId);
            if (!entry || !entry.powered) {
                hide();
                return;
            }
        }

        show();
    }

    // ==============================================================
    // PUBLIC API
    // ==============================================================
    function init() {
        if (initialized) return;
        initialized = true;

        bar = createBar();
        bar.style.display = 'none';
        document.body.appendChild(bar);
    }

    function setFloor(floorId) {
        currentFloorId = floorId ? floorId.replace('floor-', '') : null;
        resetActiveModifiers();
    }

    return {
        init: init,
        setFloor: setFloor,
        syncVisibility: syncVisibility,
        show: show,
        hide: hide,
    };
})();
