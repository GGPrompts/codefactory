/**
 * BeadsBoard — Kanban board for Beads issue tracker.
 * Vanilla JS IIFE module for CodeFactory page floors.
 *
 * Usage:
 *   BeadsBoard.init(containerEl, repoPath);
 *   BeadsBoard.refresh();
 */
var BeadsBoard = (function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────

  var COLUMNS = [
    { key: "backlog",     title: "Backlog",     defaultExpanded: true },
    { key: "ready",       title: "Ready",       defaultExpanded: true },
    { key: "in-progress", title: "In Progress", defaultExpanded: true },
    { key: "blocked",     title: "Blocked",     defaultExpanded: false },
    { key: "done",        title: "Done",        defaultExpanded: false },
  ];

  var PRIORITY_COLORS = {
    0: "#ef4444",
    1: "#f97316",
    2: "#eab308",
    3: "#3b82f6",
    4: "#6b7280",
  };

  var PRIORITY_LABELS = {
    0: { label: "P0 Critical", color: "#ef4444" },
    1: { label: "P1 High",     color: "#f97316" },
    2: { label: "P2 Medium",   color: "#eab308" },
    3: { label: "P3 Low",      color: "#3b82f6" },
    4: { label: "P4 Backlog",  color: "#6b7280" },
  };

  var TYPE_COLORS = {
    bug:     "#ef4444",
    feature: "#8b5cf6",
    task:    "#f59e0b",
    epic:    "#f59e0b",
  };

  var STATUS_COLORS = {
    open:        "#3b82f6",
    in_progress: "#f59e0b",
    closed:      "#22c55e",
  };

  // ── State ──────────────────────────────────────────────────────────────

  var _container = null;
  var _repoPath = "";
  var _issues = [];
  var _loading = false;
  var _error = null;
  var _selectedIssue = null;
  var _collapsed = {};

  // ── Public API ─────────────────────────────────────────────────────────

  function init(container, repoPath) {
    _container = container;
    _repoPath = repoPath || "";

    // Initialize collapsed state from column defaults
    COLUMNS.forEach(function (col) {
      _collapsed[col.key] = !col.defaultExpanded;
    });

    if (_repoPath) {
      loadIssues();
    } else {
      render();
    }
  }

  function refresh() {
    loadIssues();
  }

  // ── Data Loading ───────────────────────────────────────────────────────

  function loadIssues() {
    if (!_repoPath) return;
    _loading = true;
    _error = null;
    render();

    var params = new URLSearchParams({ path: _repoPath });
    fetch("/api/beads/issues?" + params)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        _issues = data.issues || [];
        _loading = false;
        render();
      })
      .catch(function (err) {
        _error = err.message || "Failed to load issues";
        _loading = false;
        render();
      });
  }

  // ── Categorization ─────────────────────────────────────────────────────

  function categorizeIssues() {
    var openIssueIds = {};
    _issues.forEach(function (issue) {
      if (issue.status !== "closed") {
        openIssueIds[issue.id] = true;
      }
    });

    // Build blocked-by map
    var blockedByMap = {};
    _issues.forEach(function (issue) {
      if (!issue.dependencies) return;
      var blockers = [];
      issue.dependencies.forEach(function (d) {
        if (d.type === "blocks" && d.depends_on_id !== issue.id && openIssueIds[d.depends_on_id]) {
          blockers.push(d.depends_on_id);
        }
      });
      if (blockers.length > 0) {
        blockedByMap[issue.id] = blockers;
      }
    });

    var buckets = {
      "backlog": [],
      "ready": [],
      "in-progress": [],
      "blocked": [],
      "done": [],
    };

    _issues.forEach(function (issue) {
      if (issue.status === "closed") {
        buckets.done.push(issue);
        return;
      }
      if (issue.status === "in_progress") {
        buckets["in-progress"].push(issue);
        return;
      }
      // status === 'open'
      if (blockedByMap[issue.id]) {
        buckets.blocked.push(issue);
        return;
      }
      var hasReady = (issue.labels || []).indexOf("ready") !== -1;
      if (hasReady) {
        buckets.ready.push(issue);
      } else {
        buckets.backlog.push(issue);
      }
    });

    // Limit done to 20 most recent
    buckets.done.sort(function (a, b) {
      return (b.closed_at || "").localeCompare(a.closed_at || "");
    });
    buckets.done = buckets.done.slice(0, 20);

    // Sort others by priority
    ["backlog", "ready", "in-progress", "blocked"].forEach(function (key) {
      buckets[key].sort(function (a, b) { return a.priority - b.priority; });
    });

    return { buckets: buckets, blockedByMap: blockedByMap };
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function render() {
    if (!_container) return;

    if (_selectedIssue) {
      renderDetail();
      return;
    }

    renderBoard();
  }

  function renderBoard() {
    var html = '';

    // Top bar
    html += '<div class="bb-topbar">';
    html += '<span class="bb-topbar-title">Beads Board</span>';
    html += '<button class="bb-refresh-btn" title="Refresh issues">';
    html += _loading ? '<span class="bb-spinner"></span>' : '&#x21bb;';
    html += '</button>';
    html += '</div>';

    // Error
    if (_error) {
      html += '<div class="bb-error">' + escapeHtml(_error) + '</div>';
    }

    // Empty state
    if (!_loading && !_error && _issues.length === 0) {
      html += '<div class="bb-empty">';
      html += '<div class="bb-empty-icon">&#x1f4e5;</div>';
      html += '<p>No .beads/ directory found</p>';
      html += '<p class="bb-empty-hint">Run <code>bd create --title="..."</code> to get started</p>';
      html += '</div>';
      _container.innerHTML = html;
      bindTopbarEvents();
      return;
    }

    // Board columns
    if (_issues.length > 0) {
      var result = categorizeIssues();
      var buckets = result.buckets;
      var blockedByMap = result.blockedByMap;

      html += '<div class="bb-board">';

      COLUMNS.forEach(function (col) {
        var items = buckets[col.key] || [];
        var isCollapsed = _collapsed[col.key];

        html += '<div class="bb-column" data-col="' + col.key + '">';

        // Column header
        html += '<button class="bb-column-header" data-toggle="' + col.key + '">';
        html += '<span class="bb-column-header-left">';
        html += '<span class="bb-chevron">' + (isCollapsed ? '&#x25b6;' : '&#x25bc;') + '</span>';
        html += '<span>' + escapeHtml(col.title) + '</span>';
        html += '</span>';
        html += '<span class="bb-column-count' + (items.length > 0 ? ' bb-column-count-active' : '') + '">';
        html += items.length;
        html += '</span>';
        html += '</button>';

        if (!isCollapsed) {
          html += '<div class="bb-column-body">';
          if (items.length === 0) {
            html += '<p class="bb-no-issues">No issues</p>';
          } else {
            items.forEach(function (issue) {
              html += renderCard(issue, blockedByMap[issue.id]);
            });
          }
          html += '</div>';
        }

        html += '</div>';
      });

      html += '</div>';
    }

    _container.innerHTML = html;
    bindTopbarEvents();
    bindColumnEvents();
    bindCardEvents();
  }

  function renderCard(issue, blockedByIds) {
    var priorityColor = PRIORITY_COLORS[issue.priority] || PRIORITY_COLORS[4];
    var typeColor = (issue.issue_type && TYPE_COLORS[issue.issue_type]) || "var(--brushed-steel)";
    var displayLabels = (issue.labels || []).filter(function (l) { return l !== "ready"; }).slice(0, 3);

    var html = '';
    html += '<div class="bb-card" data-issue-id="' + escapeHtml(issue.id) + '" ';
    html += 'style="border-left-color: ' + priorityColor + '" ';
    html += 'title="' + escapeHtml(issue.title) + '">';

    // Header: type badge + priority
    html += '<div class="bb-card-header">';
    if (issue.issue_type) {
      html += '<span class="bb-type-badge" style="color: ' + typeColor + '; ';
      html += 'background: color-mix(in srgb, ' + typeColor + ' 15%, transparent)">';
      html += escapeHtml(issue.issue_type).toUpperCase();
      html += '</span>';
    }
    html += '<span class="bb-priority" style="color: ' + priorityColor + '">P' + issue.priority + '</span>';
    html += '</div>';

    // Title
    html += '<p class="bb-card-title">' + escapeHtml(issue.title) + '</p>';

    // Bottom row: labels + blocked
    html += '<div class="bb-card-footer">';
    displayLabels.forEach(function (label) {
      html += '<span class="bb-card-label">' + escapeHtml(label) + '</span>';
    });
    if (blockedByIds && blockedByIds.length > 0) {
      html += '<span class="bb-blocked-badge" title="Blocked by: ' + blockedByIds.join(", ") + '">';
      html += '&#x26a0; ' + blockedByIds.length;
      html += '</span>';
    }
    html += '</div>';

    html += '</div>';
    return html;
  }

  function renderDetail() {
    var issue = _selectedIssue;
    var priority = PRIORITY_LABELS[issue.priority] || PRIORITY_LABELS[4];
    var statusColor = STATUS_COLORS[issue.status] || "var(--brushed-steel)";

    var html = '';

    // Header
    html += '<div class="bb-detail-header">';
    html += '<button class="bb-back-btn" title="Back to board">';
    html += '&#x25c0; Board';
    html += '</button>';
    html += '<span class="bb-detail-title">' + escapeHtml(issue.title) + '</span>';
    html += '<button class="bb-copy-id-btn" data-id="' + escapeHtml(issue.id) + '" title="Copy issue ID">';
    html += '<span class="bb-copy-icon">&#x2398;</span> ' + escapeHtml(issue.id);
    html += '</button>';
    html += '</div>';

    // Body
    html += '<div class="bb-detail-body">';

    // Meta badges
    html += '<div class="bb-detail-badges">';
    html += '<span class="bb-badge" style="color: ' + statusColor + '; ';
    html += 'background: color-mix(in srgb, ' + statusColor + ' 15%, transparent)">';
    html += escapeHtml(issue.status.replace("_", " "));
    html += '</span>';
    html += '<span class="bb-badge" style="color: ' + priority.color + '; ';
    html += 'background: color-mix(in srgb, ' + priority.color + ' 15%, transparent)">';
    html += escapeHtml(priority.label);
    html += '</span>';
    if (issue.issue_type) {
      html += '<span class="bb-badge" style="color: var(--hazard-yellow); ';
      html += 'background: color-mix(in srgb, var(--hazard-yellow) 15%, transparent)">';
      html += escapeHtml(issue.issue_type).toUpperCase();
      html += '</span>';
    }
    (issue.labels || []).forEach(function (label) {
      html += '<span class="bb-label-badge">' + escapeHtml(label) + '</span>';
    });
    html += '</div>';

    // Description
    if (issue.description) {
      html += renderSection("Description", issue.description);
    }

    // Design
    if (issue.design) {
      html += renderSection("Design", issue.design);
    }

    // Notes
    if (issue.notes) {
      html += renderSection("Notes", issue.notes);
    }

    // Close reason
    if (issue.close_reason) {
      html += renderSection("Close Reason", issue.close_reason);
    }

    // Timestamps
    html += '<div class="bb-detail-timestamps">';
    if (issue.created_at) html += '<p>Created: ' + formatDate(issue.created_at) + '</p>';
    if (issue.updated_at) html += '<p>Updated: ' + formatDate(issue.updated_at) + '</p>';
    if (issue.closed_at)  html += '<p>Closed: ' + formatDate(issue.closed_at) + '</p>';
    if (issue.owner)      html += '<p>Owner: ' + escapeHtml(issue.owner) + '</p>';
    html += '</div>';

    html += '</div>';

    _container.innerHTML = html;
    bindDetailEvents();
  }

  function renderSection(title, content) {
    var html = '<div class="bb-section">';
    html += '<h3 class="bb-section-title">' + escapeHtml(title) + '</h3>';
    html += '<pre class="bb-section-content">' + escapeHtml(content) + '</pre>';
    html += '</div>';
    return html;
  }

  // ── Event Binding ──────────────────────────────────────────────────────

  function bindTopbarEvents() {
    var btn = _container.querySelector(".bb-refresh-btn");
    if (btn) {
      btn.addEventListener("click", function () {
        loadIssues();
      });
    }
  }

  function bindColumnEvents() {
    var toggles = _container.querySelectorAll("[data-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      (function (el) {
        el.addEventListener("click", function () {
          var key = el.getAttribute("data-toggle");
          _collapsed[key] = !_collapsed[key];
          render();
        });
      })(toggles[i]);
    }
  }

  function bindCardEvents() {
    var cards = _container.querySelectorAll(".bb-card");
    for (var i = 0; i < cards.length; i++) {
      (function (el) {
        el.addEventListener("click", function () {
          var id = el.getAttribute("data-issue-id");
          for (var j = 0; j < _issues.length; j++) {
            if (_issues[j].id === id) {
              _selectedIssue = _issues[j];
              render();
              return;
            }
          }
        });
      })(cards[i]);
    }
  }

  function bindDetailEvents() {
    var backBtn = _container.querySelector(".bb-back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", function () {
        _selectedIssue = null;
        render();
      });
    }

    var copyBtn = _container.querySelector(".bb-copy-id-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        var id = copyBtn.getAttribute("data-id");
        if (navigator.clipboard) {
          navigator.clipboard.writeText(id).then(function () {
            copyBtn.innerHTML = '&#x2713; ' + escapeHtml(id);
            setTimeout(function () {
              copyBtn.innerHTML = '<span class="bb-copy-icon">&#x2398;</span> ' + escapeHtml(id);
            }, 1500);
          });
        }
      });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  // ── Expose ─────────────────────────────────────────────────────────────

  return {
    init: init,
    refresh: refresh,
  };
})();
