/* ==============================================================
   ExtraKeys — Mobile extra keys (Termux-style)
   Provides key panel DOM + input handling. Bar management is in app.js.
   ============================================================== */
var ExtraKeys = (function () {
    'use strict';

    // -- Key definitions --
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
        { label: 'PGUP', type: 'sequence', value: '\x1b[5~' },
        { label: 'C-B',  type: 'sequence', value: '\x02' },
    ];

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
        { label: 'PGDN', type: 'sequence', value: '\x1b[6~' },
        { label: 'RET',  type: 'text',     value: '\r' },
    ];

    // -- Modifier state --
    var modState = { ctrl: 'inactive', alt: 'inactive' };
    var modLastTap = { ctrl: 0, alt: 0 };
    var DOUBLE_TAP_MS = 400;

    // -- State --
    var panelEl = null;       // the keys panel DOM element
    var currentFloorId = null;

    // ==============================================================
    // DOM CREATION
    // ==============================================================
    function createKeysPanel() {
        var panel = document.createElement('div');
        panel.className = 'mobile-bar-panel mobile-bar-keys';

        panel.appendChild(createRow(ROW1));
        panel.appendChild(createRow(ROW2));

        panelEl = panel;
        return panel;
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
        btn.addEventListener('touchstart', function (e) {
            e.preventDefault();
            e.stopPropagation();  // prevent swipe gesture on bar
            handleKeyTap(keyDef);
        }, { passive: false });

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
            if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
                return String.fromCharCode(code & 0x1f);
            }
            if (code === 91) return '\x1b';
            if (code === 92) return '\x1c';
            if (code === 93) return '\x1d';
        }
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
        if (!panelEl) return;
        var btns = panelEl.querySelectorAll('[data-mod]');
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

        CodeFactoryTerminals.focus(currentFloorId);
    }

    // ==============================================================
    // HELPERS
    // ==============================================================
    function isTerminalFloor(currentFloor) {
        var floorId = currentFloor ? currentFloor.replace('floor-', '') : '';
        if (!floorId || floorId === 'lobby') return false;

        var section = document.getElementById('floor-' + floorId);
        if (section && section.hasAttribute('data-page')) return false;

        if (typeof CodeFactoryTerminals !== 'undefined') {
            var entry = CodeFactoryTerminals.getTerminal(floorId);
            if (!entry || !entry.powered) return false;
        }

        return true;
    }

    function setFloor(floorId) {
        currentFloorId = floorId ? floorId.replace('floor-', '') : null;
        resetActiveModifiers();
    }

    // ==============================================================
    // PUBLIC API
    // ==============================================================
    return {
        createKeysPanel: createKeysPanel,
        setFloor: setFloor,
        isTerminalFloor: isTerminalFloor,
    };
})();
