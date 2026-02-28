/* ══════════════════════════════════════════════════════════
   CodeFactory — Elevator Logic & Scroll Handling
   ══════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── DOM References ──
    var floors = document.querySelectorAll('section.floor');
    var buttons = document.querySelectorAll('.floor-btn');
    var indicator = document.getElementById('panelIndicator');
    var arrow = document.getElementById('panelArrow');

    // ── Floor Configuration ──
    var floorConfig = {};  // id -> { name, description, command, cwd }

    // Fetch floor config from backend and apply to UI
    fetch('/api/floors')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data && data.floors) {
                data.floors.forEach(function(floor) {
                    floorConfig[floor.id] = floor;

                    // Update floor title and label in the HTML
                    var floorSection = document.getElementById('floor-' + floor.id);
                    if (floorSection) {
                        var titleEl = floorSection.querySelector('.floor-title');
                        var labelEl = floorSection.querySelector('.floor-label');
                        if (titleEl) titleEl.textContent = floor.name;
                        if (labelEl) labelEl.textContent = 'Floor ' + floor.id + ' — ' + floor.description;
                    }

                    // Update elevator button label
                    var btn = document.querySelector('.floor-btn[data-target="floor-' + floor.id + '"]');
                    if (btn) {
                        btn.setAttribute('data-label', floor.name);
                    }
                });
            }
            console.log('[CodeFactory] Floor config loaded:', Object.keys(floorConfig).length, 'floors');
        })
        .catch(function(err) {
            console.warn('[CodeFactory] Failed to load floor config:', err);
        });

    // Floor label mapping (displayed in panel indicator)
    var floorLabels = {
        'lobby': 'L',
        'floor-1': '1',
        'floor-2': '2',
        'floor-3': '3',
        'floor-4': '4',
        'floor-5': '5'
    };

    // Numeric rank for arrow direction (lobby=0, higher = higher floor)
    var floorRank = {
        'lobby': 0,
        'floor-1': 1,
        'floor-2': 2,
        'floor-3': 3,
        'floor-4': 4,
        'floor-5': 5
    };

    var currentFloor = 'lobby';
    var jumpTarget = null;

    // ══════════════════════════════════════════════════════
    // ELEVATOR SOUNDS (Web Audio API)
    // ══════════════════════════════════════════════════════
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

    // Classic two-tone elevator ding (G5 -> E5)
    function playDing() {
        if (!audioUnlocked) return;
        ensureAudio();
        var now = audioCtx.currentTime;

        // First tone - G5 (784 Hz)
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

        // Second tone - E5 (659 Hz), slightly delayed
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

    // Soft button click
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

    // Unlock audio on first user interaction
    function unlockAudio() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        ensureAudio();
    }
    document.addEventListener('click', unlockAudio, { once: false });
    document.addEventListener('touchstart', unlockAudio, { once: false });
    document.addEventListener('keydown', unlockAudio, { once: false });

    // ══════════════════════════════════════════════════════
    // SCROLL TO BOTTOM ON LOAD (start at lobby)
    // ══════════════════════════════════════════════════════
    var htmlEl = document.documentElement;
    htmlEl.style.scrollBehavior = 'auto';
    window.scrollTo(0, document.body.scrollHeight);
    // Re-enable smooth scroll after a tick
    requestAnimationFrame(function () {
        htmlEl.style.scrollBehavior = 'smooth';
    });

    // ══════════════════════════════════════════════════════
    // INTERSECTION OBSERVER (entrance animations)
    // ══════════════════════════════════════════════════════
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

    // ══════════════════════════════════════════════════════
    // SCROLL HANDLER (door animations + active floor)
    // ══════════════════════════════════════════════════════
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

            // Door animation - openness based on distance from viewport center
            var floorCenter = rect.top + rect.height / 2;
            var vpCenter = vh / 2;
            var dist = Math.abs(floorCenter - vpCenter) / vh;
            // Doors fully open when center is within 0.25vh of viewport center,
            // fully closed when center is 0.9vh+ away
            var openness = Math.max(0, Math.min(1, (0.9 - dist) / 0.65));
            // Smooth ease-in-out curve: t * t * (3 - 2 * t)
            openness = openness * openness * (3 - 2 * openness);
            // During jump navigation, keep intermediate floors closed
            if (jumpTarget && floor.id !== jumpTarget) {
                openness = 0;
            }
            floor.style.setProperty('--door-open', openness);

            // Lazy terminal initialization: init when doors are sufficiently open
            if (openness > 0.5 && floor.id !== 'lobby') {
                var floorNum = floor.id.replace('floor-', '');
                if (typeof CodeFactoryTerminals !== 'undefined' && !CodeFactoryTerminals.isInitialized(floorNum)) {
                    CodeFactoryTerminals.init(floorNum, floorConfig[floorNum] || null);
                }
            }
        });

        if (bestFloor && bestFloor !== currentFloor) {
            var prevRank = floorRank[currentFloor] || 0;
            var newRank = floorRank[bestFloor] || 0;

            currentFloor = bestFloor;
            // Clear jump mode once we've arrived at the target floor
            var arrived = !jumpTarget || bestFloor === jumpTarget;
            if (arrived && jumpTarget) {
                jumpTarget = null;
            }
            indicator.textContent = floorLabels[bestFloor] || '?';

            // Elevator ding only when doors actually open
            if (arrived) playDing();

            // Flash animation on indicator
            indicator.classList.add('flash');
            setTimeout(function () {
                indicator.classList.remove('flash');
            }, 300);

            // Arrow direction: scrolling UP the page = ascending
            if (newRank > prevRank) {
                arrow.innerHTML = '&#9650;'; // up arrow
            } else {
                arrow.innerHTML = '&#9660;'; // down arrow
            }

            // Update active button
            buttons.forEach(function (btn) {
                btn.classList.toggle('active', btn.dataset.target === bestFloor);
            });
        }
    }

    // ══════════════════════════════════════════════════════
    // BUTTON CLICKS (smooth scroll to target floor)
    // ══════════════════════════════════════════════════════
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

    // ══════════════════════════════════════════════════════
    // KEYBOARD NAVIGATION
    // ══════════════════════════════════════════════════════
    document.addEventListener('keydown', function (e) {
        // Ignore if user is typing in an input/textarea
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        var targetId = null;
        if (e.key === 'l' || e.key === 'L') {
            targetId = 'lobby';
        } else if (e.key >= '1' && e.key <= '5') {
            targetId = 'floor-' + e.key;
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

    // ══════════════════════════════════════════════════════
    // WINDOW RESIZE (refit all initialized terminals)
    // ══════════════════════════════════════════════════════
    var resizeTick = null;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTick);
        resizeTick = setTimeout(function () {
            if (typeof CodeFactoryTerminals === 'undefined') return;
            for (var i = 1; i <= 5; i++) {
                var entry = CodeFactoryTerminals.getTerminal(String(i));
                if (entry && entry.fitAddon) {
                    entry.fitAddon.fit();
                }
            }
        }, 200);
    });

    // ══════════════════════════════════════════════════════
    // INITIAL STATE
    // ══════════════════════════════════════════════════════
    updateActiveFloor();
})();
