/**
 * LobbyManager — recent dirs, working directory editor, profile management.
 * Extracted from app.js IIFE.
 *
 * Exposed as window.LobbyManager
 */
var LobbyManager = (function () {
    'use strict';

    // -- Injected references (set via init) --
    var profiles = [];
    var defaultCwd = '';
    var renderFloorsFn = null;
    var setCwdFn = null;

    // ==============================================================
    // UTILITY (local copies — small helpers duplicated to stay self-contained)
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
    // RECENT WORKING DIRECTORIES (localStorage)
    // ==============================================================
    var RECENT_DIRS_KEY = 'cf-recent-dirs';
    var RECENT_DIRS_MAX = 10;

    function getRecentDirs() {
        try {
            var raw = localStorage.getItem(RECENT_DIRS_KEY);
            if (!raw) return [];
            var dirs = JSON.parse(raw);
            return Array.isArray(dirs) ? dirs.slice(0, RECENT_DIRS_MAX) : [];
        } catch (e) { return []; }
    }

    function addRecentDir(path) {
        if (!path) return;
        var dirs = getRecentDirs().filter(function(d) { return d !== path; });
        dirs.unshift(path);
        if (dirs.length > RECENT_DIRS_MAX) dirs = dirs.slice(0, RECENT_DIRS_MAX);
        try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs)); } catch (e) { /* ignore */ }
    }

    function removeRecentDir(path) {
        var dirs = getRecentDirs().filter(function(d) { return d !== path; });
        try { localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs)); } catch (e) { /* ignore */ }
    }

    // ==============================================================
    // LOBBY WORKING DIRECTORY
    // ==============================================================
    function initLobbyWorkdir() {
        var pathEl = document.getElementById('workdir-path');
        var displayEl = document.getElementById('workdir-display');
        var editorEl = document.getElementById('workdir-editor');
        var inputEl = document.getElementById('workdir-input');
        var editBtn = document.getElementById('workdir-edit-btn');
        var saveBtn = document.getElementById('workdir-save-btn');
        var cancelBtn = document.getElementById('workdir-cancel-btn');
        var recentEl = document.getElementById('workdir-recent');

        if (!pathEl) return;

        // Show current value
        pathEl.textContent = defaultCwd || '~';

        // Seed the current defaultCwd into recent dirs
        if (defaultCwd) addRecentDir(defaultCwd);

        function renderRecentDirs() {
            if (!recentEl) return;
            var dirs = getRecentDirs();
            if (dirs.length === 0) {
                recentEl.innerHTML = '';
                recentEl.classList.remove('has-items');
                return;
            }
            var html = '';
            for (var i = 0; i < dirs.length; i++) {
                html += '<div class="workdir-recent-item" data-path="' + escapeAttr(dirs[i]) + '">' +
                    '<span class="workdir-recent-path">' + escapeHtml(dirs[i]) + '</span>' +
                    '<button class="workdir-recent-remove" data-path="' + escapeAttr(dirs[i]) + '" title="Remove">[X]</button>' +
                    '</div>';
            }
            recentEl.innerHTML = html;
            recentEl.classList.add('has-items');

            // Attach click handlers
            recentEl.querySelectorAll('.workdir-recent-item').forEach(function(item) {
                item.addEventListener('click', function(e) {
                    // Ignore if clicking the remove button
                    if (e.target.classList.contains('workdir-recent-remove')) return;
                    var path = item.dataset.path;
                    inputEl.value = path;
                    saveWorkdir();
                });
            });

            recentEl.querySelectorAll('.workdir-recent-remove').forEach(function(btn) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    removeRecentDir(btn.dataset.path);
                    renderRecentDirs();
                });
            });
        }

        function enterWorkdirEdit() {
            inputEl.value = defaultCwd || '';
            displayEl.style.display = 'none';
            editorEl.style.display = '';
            renderRecentDirs();
            setTimeout(function() { inputEl.focus(); inputEl.select(); }, 50);
        }

        function exitWorkdirEdit() {
            editorEl.style.display = 'none';
            displayEl.style.display = '';
            if (recentEl) recentEl.classList.remove('has-items');
        }

        function saveWorkdir() {
            var newCwd = inputEl.value.trim();
            if (!newCwd) return;

            saveBtn.textContent = '[SAVING...]';

            // Build profiles payload preserving null cwd for project-dependent floors
            var updatedProfiles = profiles.map(function(p) {
                return {
                    name: p.name,
                    command: p.command || null,
                    cwd: p.cwd || null,
                    icon: p.icon || null,
                    panel: p.panel || null,
                    page: p.page || null,
                    enabled: p.enabled !== false,
                };
            });

            fetch('/api/profiles', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    default_cwd: newCwd,
                    profiles: updatedProfiles,
                }),
            })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function() {
                defaultCwd = newCwd;
                if (setCwdFn) setCwdFn(newCwd);
                pathEl.textContent = newCwd;
                addRecentDir(newCwd);

                // Update displayed cwd for floors that inherit default
                profiles.forEach(function(p) {
                    var floorId = p.id;
                    if (!p.cwd) {
                        var cwdEl = document.querySelector('#floor-' + floorId + ' .profile-cwd');
                        if (cwdEl) cwdEl.textContent = newCwd;
                        var cwdInput = document.getElementById('edit-cwd-' + floorId);
                        if (cwdInput && cwdInput.value === '') cwdInput.value = '';
                    }
                });

                exitWorkdirEdit();
                console.log('[CodeFactory] Working directory updated: ' + newCwd);
            })
            .catch(function(err) {
                console.error('[CodeFactory] Failed to save working directory:', err);
                saveBtn.textContent = '[ERROR]';
                setTimeout(function() { saveBtn.textContent = '[SAVE]'; }, 2000);
            });
        }

        editBtn.addEventListener('click', enterWorkdirEdit);
        cancelBtn.addEventListener('click', exitWorkdirEdit);
        saveBtn.addEventListener('click', saveWorkdir);

        inputEl.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') saveWorkdir();
            if (e.key === 'Escape') exitWorkdirEdit();
        });

        var browseBtn = document.getElementById('workdir-browse-btn');
        if (browseBtn && typeof FilePicker !== 'undefined') {
            browseBtn.addEventListener('click', function() {
                FilePicker.open({
                    mode: 'dir',
                    startPath: inputEl.value.trim() || defaultCwd || '~',
                    onSelect: function(path) {
                        inputEl.value = path;
                        saveWorkdir();
                    }
                });
            });
        }
    }

    // ==============================================================
    // LOBBY PROFILE MANAGEMENT
    // ==============================================================
    function buildLobbyProfileCardHTML(profile, index) {
        var name = profile.name || 'Untitled';
        var icon = profile.icon || '';
        var command = profile.command || '';
        var cwd = profile.cwd || '';
        var panel = profile.panel || '';
        var page = profile.page || '';
        var enabled = profile.enabled !== false;
        var isFirst = index === 0;
        var isLast = index === profiles.length - 1;

        var statusClass = enabled ? 'enabled' : 'disabled-badge';
        var statusText = enabled ? 'ON' : 'OFF';
        var disabledClass = enabled ? '' : ' disabled';

        return '' +
            '<div class="lobby-profile-item' + disabledClass + '" data-index="' + index + '">' +
                '<div class="lobby-profile-summary" data-index="' + index + '">' +
                    '<span class="lobby-profile-icon">' + escapeHtml(icon || String(index + 1)) + '</span>' +
                    '<span class="lobby-profile-name">' + escapeHtml(name) + '</span>' +
                    '<span class="lobby-profile-type ' + (page ? 'type-page' : 'type-trm') + '">' + (page ? 'PAGE' : 'TRM') + '</span>' +
                    '<span class="lobby-profile-cmd">' + escapeHtml(command || '—') + '</span>' +
                    '<span class="lobby-profile-status ' + statusClass + '">' + statusText + '</span>' +
                    '<button class="lobby-move-btn" data-action="move-up" data-index="' + index + '"' + (isFirst ? ' disabled' : '') + '>&#9650;</button>' +
                    '<button class="lobby-move-btn" data-action="move-down" data-index="' + index + '"' + (isLast ? ' disabled' : '') + '>&#9660;</button>' +
                '</div>' +
                '<div class="lobby-profile-edit" data-index="' + index + '">' +
                    '<div class="edit-field">' +
                        '<label>NAME</label>' +
                        '<input type="text" class="edit-input lobby-edit-name" value="' + escapeAttr(name) + '">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>COMMAND <span class="label-hint">(blank for page floors)</span></label>' +
                        '<input type="text" class="edit-input lobby-edit-command" value="' + escapeAttr(command) + '">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>CWD <span class="label-hint">(blank = inherit global)</span></label>' +
                        '<div class="edit-field-row">' +
                            '<input type="text" class="edit-input lobby-edit-cwd" value="' + escapeAttr(cwd) + '" placeholder="' + escapeAttr(defaultCwd || '~') + '">' +
                            '<button type="button" class="browse-btn lobby-browse-btn" data-browse="dir" data-target-class="lobby-edit-cwd" data-index="' + index + '">BROWSE</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>ICON</label>' +
                        '<input type="text" class="edit-input edit-input-icon lobby-edit-icon" value="' + escapeAttr(icon) + '" placeholder="emoji">' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>PANEL <span class="label-hint">(markdown filename)</span></label>' +
                        '<div class="edit-field-row">' +
                            '<input type="text" class="edit-input lobby-edit-panel" value="' + escapeAttr(panel) + '" placeholder="(optional)">' +
                            '<button type="button" class="browse-btn lobby-browse-btn" data-browse="file" data-target-class="lobby-edit-panel" data-index="' + index + '">BROWSE</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="edit-field">' +
                        '<label>PAGE <span class="label-hint">(HTML path — sets floor as page type)</span></label>' +
                        '<div class="edit-field-row">' +
                            '<input type="text" class="edit-input lobby-edit-page" value="' + escapeAttr(page) + '" placeholder="(optional)">' +
                            '<button type="button" class="browse-btn lobby-browse-btn" data-browse="file" data-target-class="lobby-edit-page" data-index="' + index + '">BROWSE</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="lobby-edit-actions">' +
                        '<button class="lobby-save-btn" data-action="save" data-index="' + index + '">[SAVE]</button>' +
                        '<button class="lobby-cancel-btn" data-action="cancel" data-index="' + index + '">[CANCEL]</button>' +
                        '<button class="lobby-toggle-btn" data-action="toggle" data-index="' + index + '">[' + (enabled ? 'DISABLE' : 'ENABLE') + ']</button>' +
                        '<button class="lobby-delete-btn" data-action="delete" data-index="' + index + '">[DELETE]</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
    }

    function renderLobbyProfiles() {
        var container = document.getElementById('lobby-profile-list');
        if (!container) return;

        var html = '';
        for (var i = profiles.length - 1; i >= 0; i--) {
            if (profiles[i]._temp) continue;  // skip transient floors in lobby management
            html += buildLobbyProfileCardHTML(profiles[i], i);
        }
        container.innerHTML = html;
    }

    function serializeProfiles() {
        return profiles
            .filter(function(p) { return !p._temp; })  // exclude transient floors
            .map(function(p) {
                return {
                    name: p.name,
                    command: p.command || null,
                    cwd: (p.cwd && p.cwd !== defaultCwd) ? p.cwd : null,
                    icon: p.icon || null,
                    panel: p.panel || null,
                    page: p.page || null,
                    enabled: p.enabled !== false,
                };
            });
    }

    function saveLobbyProfiles(onSuccess) {
        var body = JSON.stringify({
            default_cwd: defaultCwd,
            profiles: serializeProfiles(),
        });

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
            renderLobbyProfiles();
            if (renderFloorsFn) renderFloorsFn(profiles);
            if (onSuccess) onSuccess();
            console.log('[CodeFactory] Lobby profiles saved');
        })
        .catch(function(err) {
            console.error('[CodeFactory] Failed to save lobby profiles:', err);
        });
    }

    function initLobbySettings() {
        var container = document.getElementById('lobby-profiles');
        var addBtn = document.getElementById('lobby-add-btn');
        if (!container) return;

        renderLobbyProfiles();

        // Event delegation on the profile list
        container.addEventListener('click', function(e) {
            var target = e.target;

            // Move up/down buttons
            if (target.classList.contains('lobby-move-btn')) {
                e.stopPropagation();
                var action = target.dataset.action;
                var idx = parseInt(target.dataset.index, 10);
                if (action === 'move-up' && idx > 0) {
                    var tmp = profiles[idx];
                    profiles[idx] = profiles[idx - 1];
                    profiles[idx - 1] = tmp;
                    saveLobbyProfiles();
                } else if (action === 'move-down' && idx < profiles.length - 1) {
                    var tmp2 = profiles[idx];
                    profiles[idx] = profiles[idx + 1];
                    profiles[idx + 1] = tmp2;
                    saveLobbyProfiles();
                }
                return;
            }

            // Browse buttons (FilePicker) for lobby edit fields
            if (target.classList.contains('lobby-browse-btn') && typeof FilePicker !== 'undefined') {
                e.stopPropagation();
                var browseMode = target.dataset.browse;
                var targetClass = target.dataset.targetClass;
                var browseIdx = target.dataset.index;
                var editDiv = container.querySelector('.lobby-profile-edit[data-index="' + browseIdx + '"]');
                if (!editDiv) return;
                var inputEl = editDiv.querySelector('.' + targetClass);
                if (!inputEl) return;
                FilePicker.open({
                    mode: browseMode,
                    startPath: inputEl.value.trim() || defaultCwd || '~',
                    onSelect: function(path) { inputEl.value = path; }
                });
                return;
            }

            // Edit form action buttons
            var actionBtn = target.closest('[data-action]');
            if (actionBtn && actionBtn.dataset.action !== 'move-up' && actionBtn.dataset.action !== 'move-down') {
                e.stopPropagation();
                var btnAction = actionBtn.dataset.action;
                var btnIdx = parseInt(actionBtn.dataset.index, 10);

                if (btnAction === 'save') {
                    var editDiv = container.querySelector('.lobby-profile-edit[data-index="' + btnIdx + '"]');
                    if (!editDiv) return;

                    var newName = editDiv.querySelector('.lobby-edit-name').value.trim();
                    if (!newName) {
                        editDiv.querySelector('.lobby-edit-name').classList.add('input-error');
                        setTimeout(function() {
                            editDiv.querySelector('.lobby-edit-name').classList.remove('input-error');
                        }, 1000);
                        return;
                    }

                    var newCmd = editDiv.querySelector('.lobby-edit-command').value.trim();
                    var newCwd = editDiv.querySelector('.lobby-edit-cwd').value.trim();
                    var newIcon = editDiv.querySelector('.lobby-edit-icon').value.trim();
                    var newPanel = editDiv.querySelector('.lobby-edit-panel').value.trim();
                    var newPage = editDiv.querySelector('.lobby-edit-page').value.trim();

                    profiles[btnIdx].name = newName;
                    profiles[btnIdx].command = newCmd || null;
                    profiles[btnIdx].cwd = (newCwd && newCwd !== defaultCwd) ? newCwd : null;
                    profiles[btnIdx].icon = newIcon || null;
                    profiles[btnIdx].panel = newPanel || null;
                    profiles[btnIdx].page = newPage || null;

                    actionBtn.textContent = '[SAVING...]';
                    saveLobbyProfiles(function() {
                        // Collapse form after save
                        editDiv.style.display = 'none';
                    });

                } else if (btnAction === 'cancel') {
                    var editForm = container.querySelector('.lobby-profile-edit[data-index="' + btnIdx + '"]');
                    if (editForm) editForm.style.display = 'none';

                } else if (btnAction === 'toggle') {
                    var wasEnabled = profiles[btnIdx].enabled !== false;
                    profiles[btnIdx].enabled = !wasEnabled;
                    saveLobbyProfiles();

                } else if (btnAction === 'delete') {
                    var profileName = profiles[btnIdx].name || 'this profile';
                    if (!confirm('Delete "' + profileName + '"? This cannot be undone.')) return;
                    profiles.splice(btnIdx, 1);
                    saveLobbyProfiles();
                }
                return;
            }

            // Click on summary row to expand/collapse edit form
            var summary = target.closest('.lobby-profile-summary');
            if (summary) {
                var summaryIdx = parseInt(summary.dataset.index, 10);
                var editPanel = container.querySelector('.lobby-profile-edit[data-index="' + summaryIdx + '"]');
                if (editPanel) {
                    var isVisible = editPanel.style.display === 'block';
                    // Collapse all others first
                    container.querySelectorAll('.lobby-profile-edit').forEach(function(el) {
                        el.style.display = 'none';
                    });
                    if (!isVisible) {
                        editPanel.style.display = 'block';
                    }
                }
            }
        });

        // Add profile button
        if (addBtn) {
            addBtn.addEventListener('click', function() {
                profiles.push({
                    name: 'New Profile',
                    command: null,
                    cwd: null,
                    icon: null,
                    panel: null,
                    page: null,
                    enabled: true,
                });
                saveLobbyProfiles(function() {
                    // Auto-expand the new profile's edit form
                    var lastEdit = container.querySelector('.lobby-profile-edit[data-index="' + (profiles.length - 1) + '"]');
                    if (lastEdit) {
                        lastEdit.style.display = 'block';
                        var nameInput = lastEdit.querySelector('.lobby-edit-name');
                        if (nameInput) {
                            setTimeout(function() { nameInput.focus(); nameInput.select(); }, 50);
                        }
                    }
                });
            });
        }
    }

    // ==============================================================
    // PUBLIC API
    // ==============================================================

    /**
     * init(profilesRef, cwd, renderFloors, setCwd)
     *   profilesRef  — the live profiles array (mutated in place)
     *   cwd          — initial default working directory string
     *   renderFloors — callback fn(profiles) to re-render floors (avoids circular deps)
     *   setCwd       — callback fn(newCwd) to sync defaultCwd back to caller
     */
    function init(profilesRef, cwd, renderFloors, setCwd) {
        profiles = profilesRef;
        defaultCwd = cwd;
        renderFloorsFn = renderFloors;
        setCwdFn = setCwd || null;
        initLobbyWorkdir();
        initLobbySettings();
    }

    /**
     * getDefaultCwd() — returns the current default cwd
     * (may have changed after user edits the workdir)
     */
    function getDefaultCwd() {
        return defaultCwd;
    }

    /**
     * serializeProfiles() — returns profiles array ready for API, filtering out _temp floors
     */

    return {
        init: init,
        renderProfiles: renderLobbyProfiles,
        serializeProfiles: serializeProfiles,
        getDefaultCwd: getDefaultCwd
    };
})();
