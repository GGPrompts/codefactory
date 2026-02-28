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
        floorCount = profileList.length;
        var html = '';

        // Build floors top-down (highest number first)
        for (var i = floorCount; i >= 1; i--) {
            var profile = profileList[i - 1];  // profiles are 0-indexed, floors are 1-indexed
            var floorId = profile.id || String(i);

            html += buildFloorHTML(floorId, profile);

            // Shaft wall between floors (and before lobby)
            html += buildShaftWallHTML(floorId);
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
        renderElevatorButtons(profileList);

        // Rebuild references
        rebuildDOMReferences(profileList);

        // Attach floor event listeners (power on/off, edit)
        attachFloorListeners(profileList);
    }

    function buildFloorHTML(floorId, profile) {
        var name = profile.name || 'Terminal Bay ' + floorId;
        var command = profile.command || 'bash';
        var cwd = profile.cwd || defaultCwd || '~';
        var icon = profile.icon || '';

        return '' +
            '<section class="floor powered-off" id="floor-' + floorId + '">' +
                '<div class="elevator-doors">' +
                    '<div class="door door-left"></div>' +
                    '<div class="door door-right"></div>' +
                '</div>' +
                '<div class="floor-frame">' +
                    '<div class="floor-header">' +
                        '<span class="floor-label">Floor ' + floorId + '</span>' +
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
                    '<div class="profile-edit-form" id="edit-form-' + floorId + '" style="display:none;">' +
                        '<div class="edit-field">' +
                            '<label>NAME</label>' +
                            '<input type="text" class="edit-input" id="edit-name-' + floorId + '" value="' + escapeAttr(name) + '">' +
                        '</div>' +
                        '<div class="edit-field">' +
                            '<label>COMMAND</label>' +
                            '<input type="text" class="edit-input" id="edit-command-' + floorId + '" value="' + escapeAttr(command) + '">' +
                        '</div>' +
                        '<div class="edit-field">' +
                            '<label>CWD</label>' +
                            '<input type="text" class="edit-input" id="edit-cwd-' + floorId + '" value="' + escapeAttr(cwd) + '">' +
                        '</div>' +
                        '<div class="edit-actions">' +
                            '<button class="power-btn save-btn" data-floor="' + floorId + '">[SAVE]</button>' +
                            '<button class="power-btn cancel-btn" data-floor="' + floorId + '">[CANCEL]</button>' +
                        '</div>' +
                    '</div>' +
                    '<!-- Terminal container (shown when powered on) -->' +
                    '<div class="terminal-container" id="terminal-' + floorId + '"></div>' +
                    '<!-- Power off button (shown when powered on) -->' +
                    '<div class="power-off-bar" id="power-off-bar-' + floorId + '">' +
                        '<button class="power-btn power-off-btn" data-floor="' + floorId + '">[POWER OFF]</button>' +
                    '</div>' +
                '</div>' +
            '</section>';
    }

    function buildShaftWallHTML(floorId) {
        return '' +
            '<div class="shaft-wall">' +
                '<div class="caution-stripe"></div>' +
                '<span class="shaft-wall-number">' + escapeHtml(floorId) + '</span>' +
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
            html += '<button class="floor-btn" data-target="floor-' + floorId +
                    '" data-label="' + escapeAttr(name) + '">' + floorId + '</button>';
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
                    CodeFactoryTerminals.powerOn(floorId, profile);
                }
            });
        });

        // Power OFF buttons
        document.querySelectorAll('.power-off-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var floorId = btn.dataset.floor;
                CodeFactoryTerminals.powerOff(floorId);
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
            if (nameInput) nameInput.value = profile.name || '';
            if (cmdInput) cmdInput.value = profile.command || '';
            if (cwdInput) cwdInput.value = profile.cwd || defaultCwd || '';
        }
    }

    function saveProfile(floorId) {
        var idx = findProfileIndex(floorId);
        if (idx === -1) return;

        var nameInput = document.getElementById('edit-name-' + floorId);
        var cmdInput = document.getElementById('edit-command-' + floorId);
        var cwdInput = document.getElementById('edit-cwd-' + floorId);

        var newName = nameInput ? nameInput.value.trim() : '';
        var newCommand = cmdInput ? cmdInput.value.trim() : '';
        var newCwd = cwdInput ? cwdInput.value.trim() : '';

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
                    icon: p.icon || null,
                };
            }
            return {
                name: p.name,
                command: p.command || null,
                cwd: (p.cwd && p.cwd !== defaultCwd) ? p.cwd : null,
                icon: p.icon || null,
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
            // Update local state
            profiles[idx].name = newName;
            profiles[idx].command = newCommand || null;
            profiles[idx].cwd = newCwd || null;

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
            }

            // Update elevator button label
            var btn = document.querySelector('.floor-btn[data-target="floor-' + floorId + '"]');
            if (btn) btn.setAttribute('data-label', newName);

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
        if (!audioUnlocked) return;
        ensureAudio();
        var now = audioCtx.currentTime;

        var osc1 = audioCtx.createOscillator();
        var gain1 = audioCtx.createGain();
        osc1.type = 'sine';
        osc1.frequency.value = 784;
        gain1.gain.setValueAtTime(sfxVolume, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(now);
        osc1.stop(now + 0.6);

        var osc2 = audioCtx.createOscillator();
        var gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.value = 659;
        gain2.gain.setValueAtTime(0.001, now);
        gain2.gain.setValueAtTime(sfxVolume * 0.85, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.75);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.75);
    }

    function playClick() {
        if (!audioUnlocked) return;
        ensureAudio();
        var now = audioCtx.currentTime;
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = 1800;
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.03);
        gain.gain.setValueAtTime(sfxVolume * 0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.06);
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
                var arrived = !jumpTarget || bestFloor === jumpTarget;
                if (arrived && jumpTarget) {
                    jumpTarget = null;
                }
                indicator.textContent = floorLabels[bestFloor] || '?';

                if (arrived) playDing();

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
                    target.scrollIntoView({ behavior: 'smooth' });
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
                    target.scrollIntoView({ behavior: 'smooth' });
                }
            }
        });

        // Window resize: refit all powered-on terminals
        var resizeTick = null;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTick);
            resizeTick = setTimeout(function () {
                if (typeof CodeFactoryTerminals === 'undefined') return;
                for (var i = 1; i <= floorCount; i++) {
                    var entry = CodeFactoryTerminals.getTerminal(String(i));
                    if (entry && entry.fitAddon && entry.powered) {
                        entry.fitAddon.fit();
                    }
                }
            }, 200);
        });

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
