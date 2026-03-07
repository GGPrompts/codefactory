/**
 * FloorEdit — edit mode for floor profiles (enter, exit, save).
 * Extracted from app.js IIFE.
 *
 * Exposed as window.FloorEdit
 */
var FloorEdit = (function () {
    'use strict';

    // Currently-editing floor ID (null if none)
    var editingFloor = null;

    /**
     * Enter edit mode for a floor profile card.
     */
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

    /**
     * Exit edit mode, resetting form values to current profile state.
     *
     * @param {string}   floorId
     * @param {object}   ctx  – { findProfile, defaultCwd }
     */
    function exitEditMode(floorId, ctx) {
        editingFloor = null;
        var card = document.getElementById('profile-card-' + floorId);
        var form = document.getElementById('edit-form-' + floorId);
        if (card) card.style.display = '';
        if (form) form.style.display = 'none';

        // Reset form values to current profile
        var profile = ctx.findProfile(floorId);
        if (profile) {
            var nameInput = document.getElementById('edit-name-' + floorId);
            var cmdInput = document.getElementById('edit-command-' + floorId);
            var cwdInput = document.getElementById('edit-cwd-' + floorId);
            var iconInput = document.getElementById('edit-icon-' + floorId);
            var panelInput = document.getElementById('edit-panel-' + floorId);
            var pageInput = document.getElementById('edit-page-' + floorId);
            if (nameInput) nameInput.value = profile.name || '';
            if (cmdInput) cmdInput.value = profile.command || '';
            if (cwdInput) cwdInput.value = profile.cwd || ctx.defaultCwd || '';
            if (iconInput) iconInput.value = profile.icon || '';
            if (panelInput) panelInput.value = profile.panel || '';
            if (pageInput) pageInput.value = profile.page || '';
        }
    }

    /**
     * Save profile edits to the backend and update the UI.
     *
     * @param {string}   floorId
     * @param {object}   ctx  – { profiles, defaultCwd, findProfile, findProfileIndex }
     */
    function saveProfile(floorId, ctx) {
        var idx = ctx.findProfileIndex(floorId);
        if (idx === -1) return;

        var profiles = ctx.profiles;
        var defaultCwd = ctx.defaultCwd;

        // Temp floors cannot be saved to disk
        if (profiles[idx]._temp) {
            exitEditMode(floorId, ctx);
            return;
        }

        var nameInput = document.getElementById('edit-name-' + floorId);
        var cmdInput = document.getElementById('edit-command-' + floorId);
        var cwdInput = document.getElementById('edit-cwd-' + floorId);
        var iconInput = document.getElementById('edit-icon-' + floorId);
        var panelInput = document.getElementById('edit-panel-' + floorId);
        var pageInput = document.getElementById('edit-page-' + floorId);

        var newName = nameInput ? nameInput.value.trim() : '';
        var newCommand = cmdInput ? cmdInput.value.trim() : '';
        var newCwd = cwdInput ? cwdInput.value.trim() : '';
        var newIcon = iconInput ? iconInput.value.trim() : '';
        var newPanel = panelInput ? panelInput.value.trim() : '';
        var newPage = pageInput ? pageInput.value.trim() : '';

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
                    icon: newIcon || null,
                    panel: newPanel || null,
                    page: newPage || null,
                    enabled: p.enabled !== false,
                };
            }
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
            // Update local state (preserve null for cwd that matches default)
            profiles[idx].name = newName;
            profiles[idx].command = newCommand || null;
            profiles[idx].cwd = (newCwd && newCwd !== defaultCwd) ? newCwd : null;
            profiles[idx].icon = newIcon || null;
            profiles[idx].panel = newPanel || null;
            profiles[idx].page = newPage || null;

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
                var iconEl = floorSection.querySelector('.profile-icon');
                if (iconEl) iconEl.textContent = newIcon || floorId;
            }

            // Update elevator button content and label
            var btn = document.querySelector('.floor-btn[data-target="floor-' + floorId + '"]');
            if (btn) {
                btn.setAttribute('data-label', newName);
                btn.textContent = newIcon || floorId;
                if (newIcon) {
                    btn.classList.add('has-icon');
                } else {
                    btn.classList.remove('has-icon');
                }
            }

            exitEditMode(floorId, ctx);
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

    /**
     * Return the floor ID currently being edited, or null.
     */
    function getEditingFloor() {
        return editingFloor;
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    return {
        enterEditMode: enterEditMode,
        exitEditMode: exitEditMode,
        saveProfile: saveProfile,
        getEditingFloor: getEditingFloor
    };
})();
