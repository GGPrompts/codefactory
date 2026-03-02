/**
 * CodeFactory Git Graph — vanilla JS port of markdown-themes GitGraph
 *
 * Provides a mobile-friendly commit graph visualization.
 * Exposes window.GitGraph = { init: function(container, repoPath) }
 */
(function () {
  "use strict";

  var ROW_HEIGHT = 40;
  var RAIL_WIDTH = 20;
  var NODE_RADIUS = 6;
  var PAGE_SIZE = 50;

  var RAIL_COLORS = [
    "#6bcaf7", // cyan
    "#f76b6b", // red
    "#6bf78e", // green
    "#f7a86b", // orange
    "#b76bf7", // purple
    "#f76bb7", // pink
    "#b7f76b", // olive
    "#c4a8ff", // lavender
  ];

  function getRailColor(rail) {
    return RAIL_COLORS[rail % RAIL_COLORS.length];
  }

  // ── Graph Layout Algorithm ──────────────────────────────────────────────

  function calculateGraphLayout(commits) {
    if (commits.length === 0) {
      return { nodes: [], connections: [], railCount: 0 };
    }

    var nodes = [];
    var connections = [];
    var expectedParents = {}; // hash -> [rail, rail, ...]
    var activeRails = {};     // rail -> hash|null
    var commitRowMap = {};    // hash -> row
    var commitRailMap = {};   // hash -> rail
    var maxRail = 0;

    for (var row = 0; row < commits.length; row++) {
      var commit = commits[row];
      var rail;
      var parents = commit.parents || [];
      var refs = commit.refs || [];

      // Check if any rails are expecting this commit
      var expectingRails = expectedParents[commit.hash] || [];

      if (expectingRails.length > 0) {
        rail = Math.min.apply(null, expectingRails);

        // Free up other rails expecting this commit
        for (var ei = 0; ei < expectingRails.length; ei++) {
          if (expectingRails[ei] !== rail) {
            delete activeRails[expectingRails[ei]];
          }
        }
        delete expectedParents[commit.hash];
      } else {
        // Find first free rail
        rail = 0;
        while (activeRails.hasOwnProperty(rail)) {
          rail++;
        }
      }

      if (rail > maxRail) maxRail = rail;

      commitRowMap[commit.hash] = row;
      commitRailMap[commit.hash] = rail;

      nodes.push({
        hash: commit.hash,
        shortHash: commit.shortHash,
        message: commit.message,
        author: commit.author,
        date: commit.date,
        parents: parents,
        refs: refs,
        rail: rail,
        row: row,
      });

      if (parents.length === 0) {
        delete activeRails[rail];
      } else {
        // First parent continues on same rail
        var firstParent = parents[0];
        activeRails[rail] = firstParent;

        if (!expectedParents[firstParent]) expectedParents[firstParent] = [];
        expectedParents[firstParent].push(rail);

        // Additional parents get new rails (merge)
        for (var pi = 1; pi < parents.length; pi++) {
          var parentHash = parents[pi];
          var newRail = 0;
          while (activeRails.hasOwnProperty(newRail)) {
            newRail++;
          }
          activeRails[newRail] = parentHash;
          if (newRail > maxRail) maxRail = newRail;

          if (!expectedParents[parentHash]) expectedParents[parentHash] = [];
          expectedParents[parentHash].push(newRail);
        }
      }
    }

    // Generate connections
    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      var nodeParents = node.parents || [];
      for (var ci = 0; ci < nodeParents.length; ci++) {
        var pHash = nodeParents[ci];
        var parentRow = commitRowMap[pHash];
        var parentRail = commitRailMap[pHash];

        if (parentRow !== undefined && parentRail !== undefined) {
          var type;
          if (node.rail === parentRail) {
            type = "straight";
          } else if (node.rail > parentRail) {
            type = "merge-left";
          } else {
            type = "merge-right";
          }

          connections.push({
            fromHash: node.hash,
            toHash: pHash,
            fromRail: node.rail,
            toRail: parentRail,
            fromRow: node.row,
            toRow: parentRow,
            type: type,
          });
        }
      }
    }

    return {
      nodes: nodes,
      connections: connections,
      railCount: maxRail + 1,
    };
  }

  // ── Canvas Drawing ──────────────────────────────────────────────────────

  function drawCanvas(canvas, connections, railCount, rowHeight, railWidth, nodeRadius, width, height) {
    var ctx = canvas.getContext("2d");
    if (!ctx) return;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (var i = 0; i < connections.length; i++) {
      var conn = connections[i];
      var fromX = (conn.fromRail + 0.5) * railWidth;
      var fromY = conn.fromRow * rowHeight + rowHeight / 2;
      var toX = (conn.toRail + 0.5) * railWidth;
      var toY = conn.toRow * rowHeight + rowHeight / 2;

      ctx.strokeStyle = getRailColor(conn.fromRail);
      ctx.beginPath();

      if (conn.type === "straight") {
        ctx.moveTo(fromX, fromY + nodeRadius);
        ctx.lineTo(toX, toY - nodeRadius);
      } else {
        ctx.moveTo(fromX, fromY + nodeRadius);
        var midY = (fromY + toY) / 2;

        if (conn.fromRow + 1 === conn.toRow) {
          ctx.bezierCurveTo(fromX, midY, toX, midY, toX, toY - nodeRadius);
        } else {
          var curveStartY = toY - rowHeight;
          ctx.lineTo(fromX, curveStartY);
          ctx.bezierCurveTo(
            fromX, curveStartY + rowHeight * 0.5,
            toX, curveStartY + rowHeight * 0.5,
            toX, toY - nodeRadius
          );
        }
      }

      ctx.stroke();
    }
  }

  // ── Helper Functions ────────────────────────────────────────────────────

  function formatRelativeTime(dateString) {
    var date = new Date(dateString);
    var now = new Date();
    var diffMs = now.getTime() - date.getTime();
    var diffSeconds = Math.floor(diffMs / 1000);
    var diffMinutes = Math.floor(diffSeconds / 60);
    var diffHours = Math.floor(diffMinutes / 60);
    var diffDays = Math.floor(diffHours / 24);
    var diffWeeks = Math.floor(diffDays / 7);
    var diffMonths = Math.floor(diffDays / 30);
    var diffYears = Math.floor(diffDays / 365);

    if (diffSeconds < 60) return "just now";
    if (diffMinutes < 60) return diffMinutes + "m ago";
    if (diffHours < 24) return diffHours + "h ago";
    if (diffDays < 7) return diffDays + "d ago";
    if (diffWeeks < 4) return diffWeeks + "w ago";
    if (diffMonths < 12) return diffMonths + "mo ago";
    return diffYears + "y ago";
  }

  function parseRefs(refs) {
    var branches = [];
    var tags = [];
    var isHead = false;

    for (var i = 0; i < refs.length; i++) {
      var ref_ = refs[i];
      if (ref_ === "HEAD") {
        isHead = true;
      } else if (ref_.indexOf("HEAD -> ") === 0) {
        isHead = true;
        branches.push(ref_.replace("HEAD -> ", ""));
      } else if (ref_.indexOf("tag: ") === 0) {
        tags.push(ref_.replace("tag: ", ""));
      } else {
        branches.push(ref_);
      }
    }

    return { branches: branches, tags: tags, isHead: isHead };
  }

  function getInitials(author) {
    var parts = author.split(" ");
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  function getStatusSymbol(status) {
    switch (status) {
      case "A": return "+";
      case "D": return "-";
      case "M": return "~";
      case "R": return ">";
      default: return "?";
    }
  }

  function getStatusColor(status) {
    switch (status) {
      case "A": return "#4ade80";
      case "D": return "#f87171";
      case "M": return "#fbbf24";
      case "R": return "#60a5fa";
      default: return "var(--brushed-steel)";
    }
  }

  function getStatusLabel(status) {
    switch (status) {
      case "A": return "Added";
      case "D": return "Deleted";
      case "M": return "Modified";
      case "R": return "Renamed";
      default: return status;
    }
  }

  // ── Main Component ──────────────────────────────────────────────────────

  function init(container, repoPath) {
    var state = {
      commits: [],
      layout: { nodes: [], connections: [], railCount: 0 },
      loading: true,
      loadingMore: false,
      error: null,
      hasMore: true,
      skip: 0,
      selectedHash: null,
      expandedHashes: {},
    };

    var apiBase = window.location.origin;
    var scrollContainer = null;
    var graphContainer = null;
    var canvasEl = null;
    var nodesLayer = null;
    var rowsContainer = null;
    var loadingMoreEl = null;
    var endEl = null;

    function render() {
      container.innerHTML = "";

      if (state.loading && state.commits.length === 0) {
        container.innerHTML =
          '<div class="gg-center"><span class="gg-spinner"></span> Loading git history...</div>';
        return;
      }

      if (state.error && state.commits.length === 0) {
        container.innerHTML =
          '<div class="gg-center">' +
          '<div class="gg-error-icon">!</div>' +
          '<p class="gg-error-text">' + escapeHtml(state.error) + "</p>" +
          '<button class="gg-btn" onclick="this.blur()">Retry</button>' +
          "</div>";
        container.querySelector(".gg-btn").addEventListener("click", function () {
          state.commits = [];
          state.layout = { nodes: [], connections: [], railCount: 0 };
          state.loading = true;
          state.error = null;
          state.hasMore = true;
          state.skip = 0;
          render();
          fetchCommits(0, false);
        });
        return;
      }

      if (state.commits.length === 0) {
        container.innerHTML = '<div class="gg-center">No commits found</div>';
        return;
      }

      // Build main structure
      var canvasWidth = (state.layout.railCount + 1) * RAIL_WIDTH;
      var canvasHeight = state.layout.nodes.length * ROW_HEIGHT;

      var html =
        '<div class="gg-scroll">' +
        // Header
        '<div class="gg-header">' +
        '<span class="gg-header-title">Git History</span>' +
        '<button class="gg-refresh-btn" title="Refresh">&#x21bb;</button>' +
        "</div>" +
        // Graph area
        '<div class="gg-graph" style="min-height:' + canvasHeight + 'px">' +
        '<canvas class="gg-canvas" style="width:' + canvasWidth + "px;height:" + canvasHeight + 'px"></canvas>' +
        '<div class="gg-nodes" style="width:' + canvasWidth + "px;height:" + canvasHeight + 'px"></div>' +
        '<div class="gg-rows" style="margin-left:' + canvasWidth + 'px"></div>' +
        "</div>" +
        // Footer
        '<div class="gg-loading-more" style="display:none"><span class="gg-spinner"></span> Loading more...</div>' +
        '<div class="gg-end" style="display:none"></div>' +
        "</div>";

      container.innerHTML = html;

      scrollContainer = container.querySelector(".gg-scroll");
      graphContainer = container.querySelector(".gg-graph");
      canvasEl = container.querySelector(".gg-canvas");
      nodesLayer = container.querySelector(".gg-nodes");
      rowsContainer = container.querySelector(".gg-rows");
      loadingMoreEl = container.querySelector(".gg-loading-more");
      endEl = container.querySelector(".gg-end");

      // Refresh button
      container.querySelector(".gg-refresh-btn").addEventListener("click", function () {
        state.commits = [];
        state.layout = { nodes: [], connections: [], railCount: 0 };
        state.loading = true;
        state.error = null;
        state.hasMore = true;
        state.skip = 0;
        state.selectedHash = null;
        state.expandedHashes = {};
        render();
        fetchCommits(0, false);
      });

      // Draw canvas
      drawCanvas(
        canvasEl,
        state.layout.connections,
        state.layout.railCount,
        ROW_HEIGHT,
        RAIL_WIDTH,
        NODE_RADIUS,
        canvasWidth,
        canvasHeight
      );

      // Draw node circles
      renderNodes(canvasWidth, canvasHeight);

      // Draw rows
      renderRows();

      // Update footer
      updateFooter();

      // Scroll listener for infinite scroll
      scrollContainer.addEventListener("scroll", handleScroll);
    }

    function renderNodes(canvasWidth, canvasHeight) {
      var html = "";
      for (var i = 0; i < state.layout.nodes.length; i++) {
        var node = state.layout.nodes[i];
        var isMerge = (node.parents || []).length > 1;
        var isHead = false;
        var nodeRefs = node.refs || [];
        for (var ri = 0; ri < nodeRefs.length; ri++) {
          if (nodeRefs[ri] === "HEAD" || nodeRefs[ri].indexOf("HEAD ->") >= 0) {
            isHead = true;
            break;
          }
        }

        var cx = (node.rail + 0.5) * RAIL_WIDTH;
        var cy = node.row * ROW_HEIGHT + ROW_HEIGHT / 2;
        var color = getRailColor(node.rail);
        var bg = isMerge ? "var(--iron-black)" : color;
        var shadow = isHead ? "box-shadow:0 0 0 2px var(--hazard-yellow);" : "";

        html +=
          '<div class="gg-node" data-hash="' + node.hash + '" style="' +
          "left:" + (cx - NODE_RADIUS) + "px;" +
          "top:" + (cy - NODE_RADIUS) + "px;" +
          "width:" + NODE_RADIUS * 2 + "px;" +
          "height:" + NODE_RADIUS * 2 + "px;" +
          "background:" + bg + ";" +
          "border:2px solid " + color + ";" +
          shadow +
          '" title="' + escapeHtml(node.shortHash) + '"></div>';
      }
      nodesLayer.innerHTML = html;
    }

    function renderRows() {
      var html = "";
      for (var i = 0; i < state.layout.nodes.length; i++) {
        var node = state.layout.nodes[i];
        html += buildRowHTML(node);
      }
      rowsContainer.innerHTML = html;

      // Attach click handlers
      var rows = rowsContainer.querySelectorAll(".gg-row");
      for (var i = 0; i < rows.length; i++) {
        (function (rowEl) {
          rowEl.addEventListener("click", function () {
            var hash = rowEl.getAttribute("data-hash");
            handleCommitClick(hash);
          });
        })(rows[i]);
      }

      // Attach detail event handlers (stop propagation)
      var details = rowsContainer.querySelectorAll(".gg-details");
      for (var di = 0; di < details.length; di++) {
        details[di].addEventListener("click", function (e) {
          e.stopPropagation();
        });
      }
    }

    function buildRowHTML(node) {
      var parsed = parseRefs(node.refs || []);
      var isMerge = (node.parents || []).length > 1;
      var relTime = formatRelativeTime(node.date);
      var isExpanded = !!state.expandedHashes[node.hash];
      var isSelected = state.selectedHash === node.hash;

      var maxLen = 60;
      var msg = node.message.length > maxLen
        ? escapeHtml(node.message.slice(0, maxLen)) + "..."
        : escapeHtml(node.message);

      var bgStyle = "";
      if (isExpanded) {
        bgStyle = "background:color-mix(in srgb, var(--hazard-yellow) 8%, var(--iron-black));";
      } else if (isSelected) {
        bgStyle = "background:color-mix(in srgb, var(--hazard-yellow) 12%, var(--iron-black));";
      }

      var borderStyle = isExpanded ? "border-bottom:none;" : "border-bottom:1px solid var(--steel-dark);";

      var html = '<div class="gg-row-wrapper">';
      html += '<div class="gg-row" data-hash="' + node.hash + '" style="height:' + ROW_HEIGHT + "px;" + bgStyle + borderStyle + '">';

      // Chevron
      html += '<span class="gg-chevron">' + (isExpanded ? "&#9660;" : "&#9654;") + "</span>";

      // Short hash
      var hashStyle = parsed.isHead
        ? "color:var(--hazard-yellow);font-weight:600;"
        : "color:var(--brushed-steel);";
      html += '<span class="gg-hash" style="' + hashStyle + '">' + escapeHtml(node.shortHash) + "</span>";

      // Refs
      if (parsed.branches.length > 0 || parsed.tags.length > 0) {
        html += '<span class="gg-refs">';
        for (var bi = 0; bi < parsed.branches.length; bi++) {
          var br = parsed.branches[bi];
          var isRemote = br.indexOf("origin/") === 0;
          var refClass = isRemote ? "gg-ref gg-ref-remote" : "gg-ref gg-ref-branch";
          html += '<span class="' + refClass + '">' + escapeHtml(br) + "</span>";
        }
        for (var ti = 0; ti < parsed.tags.length; ti++) {
          html += '<span class="gg-ref gg-ref-tag">' + escapeHtml(parsed.tags[ti]) + "</span>";
        }
        html += "</span>";
      }

      // Message
      html += '<span class="gg-msg">';
      if (isMerge) {
        html += '<span class="gg-merge-badge">[merge]</span>';
      }
      html += msg + "</span>";

      // Author
      html +=
        '<span class="gg-author" title="' + escapeHtml(node.author) + '">' +
        '<span class="gg-avatar">' + escapeHtml(getInitials(node.author)) + "</span>" +
        '<span class="gg-author-name">' + escapeHtml(node.author.split(" ")[0]) + "</span>" +
        "</span>";

      // Time
      html += '<span class="gg-time" title="' + escapeHtml(new Date(node.date).toLocaleString()) + '">' + escapeHtml(relTime) + "</span>";

      html += "</div>"; // .gg-row

      // Expanded details placeholder
      if (isExpanded) {
        html += '<div class="gg-details" data-hash="' + node.hash + '">';
        html += '<div class="gg-details-loading"><span class="gg-spinner"></span> Loading details...</div>';
        html += "</div>";
      }

      html += "</div>"; // .gg-row-wrapper
      return html;
    }

    function handleCommitClick(hash) {
      if (state.expandedHashes[hash]) {
        delete state.expandedHashes[hash];
      } else {
        state.expandedHashes[hash] = true;
      }
      state.selectedHash = hash;

      // Re-render rows only (not full render to keep scroll position)
      renderRows();

      // Load details for newly expanded
      if (state.expandedHashes[hash]) {
        fetchCommitDetails(hash);
      }
    }

    function fetchCommitDetails(hash) {
      var detailsEl = rowsContainer.querySelector('.gg-details[data-hash="' + hash + '"]');
      if (!detailsEl) return;

      var url = apiBase + "/api/git/commit/" + hash + "?path=" + encodeURIComponent(repoPath);
      fetch(url)
        .then(function (response) {
          if (!response.ok) throw new Error("Failed to fetch commit details");
          return response.json();
        })
        .then(function (result) {
          var data = result.data;
          if (!state.expandedHashes[hash]) return; // collapsed while loading
          renderDetails(detailsEl, data);
        })
        .catch(function (err) {
          if (!state.expandedHashes[hash]) return;
          detailsEl.innerHTML = '<div class="gg-details-error">' + escapeHtml(err.message) + "</div>";
        });
    }

    function renderDetails(el, data) {
      var html = "";

      // Full message
      html += '<div class="gg-detail-msg">' + escapeHtml(data.message) + "</div>";
      if (data.body) {
        html += '<div class="gg-detail-body">' + escapeHtml(data.body) + "</div>";
      }

      // Author & date
      var meta = "";
      if (data.author) meta += escapeHtml(data.author);
      if (data.author && data.date) meta += " &middot; ";
      if (data.date) meta += escapeHtml(new Date(data.date).toLocaleString());
      if (meta) html += '<div class="gg-detail-meta">' + meta + "</div>";

      // Files
      var files = data.files || [];
      if (files.length > 0) {
        html += '<div class="gg-detail-files-header">Files changed (' + files.length + ")</div>";
        html += '<div class="gg-detail-files">';
        for (var fi = 0; fi < files.length; fi++) {
          var f = files[fi];
          html +=
            '<div class="gg-file" data-path="' + escapeHtml(f.path) + '" data-status="' + escapeHtml(f.status) + '" data-hash="' + escapeHtml(data.hash) + '">' +
            '<span class="gg-file-status" style="color:' + getStatusColor(f.status) + '">' + getStatusSymbol(f.status) + "</span>" +
            '<span class="gg-file-path">' + escapeHtml(f.path) + "</span>" +
            '<span class="gg-file-stat">' +
            (f.additions > 0 ? '<span style="color:#4ade80">+' + f.additions + "</span> " : "") +
            (f.deletions > 0 ? '<span style="color:#f87171">-' + f.deletions + "</span>" : "") +
            "</span>" +
            "</div>";
        }
        html += "</div>";
      }

      // Action buttons
      html +=
        '<div class="gg-detail-actions">' +
        '<button class="gg-btn gg-copy-hash-btn">Copy Hash</button>' +
        "</div>";

      el.innerHTML = html;

      // Copy hash handler
      el.querySelector(".gg-copy-hash-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        var btn = e.target;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(data.hash).then(function () {
            btn.textContent = "Copied!";
            setTimeout(function () { btn.textContent = "Copy Hash"; }, 2000);
          });
        }
      });

      // File click -> show diff
      var fileEls = el.querySelectorAll(".gg-file");
      for (var i = 0; i < fileEls.length; i++) {
        (function (fileEl) {
          fileEl.addEventListener("click", function (e) {
            e.stopPropagation();
            var filePath = fileEl.getAttribute("data-path");
            var commitHash = fileEl.getAttribute("data-hash");
            toggleFileDiff(fileEl, commitHash, filePath);
          });
        })(fileEls[i]);
      }
    }

    function toggleFileDiff(fileEl, commitHash, filePath) {
      // If diff already shown, remove it
      var existing = fileEl.nextElementSibling;
      if (existing && existing.classList.contains("gg-diff-container")) {
        existing.remove();
        return;
      }

      var diffContainer = document.createElement("div");
      diffContainer.className = "gg-diff-container";
      diffContainer.innerHTML = '<div class="gg-diff-loading"><span class="gg-spinner"></span> Loading diff...</div>';
      fileEl.parentNode.insertBefore(diffContainer, fileEl.nextSibling);

      var url = apiBase + "/api/git/diff?path=" + encodeURIComponent(repoPath) +
        "&base=" + encodeURIComponent(commitHash) +
        "&file=" + encodeURIComponent(filePath);

      fetch(url)
        .then(function (response) {
          if (!response.ok) throw new Error("Failed to fetch diff");
          return response.json();
        })
        .then(function (result) {
          var diff = (result.data && result.data.diff) || "";
          if (!diff.trim()) {
            diffContainer.innerHTML = '<div class="gg-diff-empty">No diff available (binary file?)</div>';
            return;
          }
          diffContainer.innerHTML = '<pre class="gg-diff">' + colorizeDiff(diff) + "</pre>";
        })
        .catch(function (err) {
          diffContainer.innerHTML = '<div class="gg-diff-error">' + escapeHtml(err.message) + "</div>";
        });
    }

    function colorizeDiff(diff) {
      var lines = diff.split("\n");
      var out = "";
      for (var i = 0; i < lines.length; i++) {
        var line = escapeHtml(lines[i]);
        if (lines[i].indexOf("+") === 0 && lines[i].indexOf("+++") !== 0) {
          out += '<span class="gg-diff-add">' + line + "</span>\n";
        } else if (lines[i].indexOf("-") === 0 && lines[i].indexOf("---") !== 0) {
          out += '<span class="gg-diff-del">' + line + "</span>\n";
        } else if (lines[i].indexOf("@@") === 0) {
          out += '<span class="gg-diff-hunk">' + line + "</span>\n";
        } else if (lines[i].indexOf("diff ") === 0 || lines[i].indexOf("index ") === 0 || lines[i].indexOf("---") === 0 || lines[i].indexOf("+++") === 0) {
          out += '<span class="gg-diff-meta">' + line + "</span>\n";
        } else {
          out += line + "\n";
        }
      }
      return out;
    }

    function updateFooter() {
      if (!loadingMoreEl || !endEl) return;

      loadingMoreEl.style.display = state.loadingMore ? "" : "none";

      if (!state.hasMore && state.commits.length > 0) {
        endEl.style.display = "";
        endEl.textContent = "End of history (" + state.commits.length + " commits)";
      } else {
        endEl.style.display = "none";
      }
    }

    function handleScroll() {
      if (!scrollContainer || state.loadingMore || !state.hasMore) return;

      var el = scrollContainer;
      var threshold = 200;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
        state.loadingMore = true;
        updateFooter();
        fetchCommits(state.skip, true);
      }
    }

    function fetchCommits(skip, append) {
      var url = apiBase + "/api/git/graph?path=" + encodeURIComponent(repoPath) +
        "&limit=" + PAGE_SIZE + "&skip=" + skip;

      fetch(url)
        .then(function (response) {
          if (!response.ok) {
            return response.json().then(function (d) {
              throw new Error(d.error || "Failed to fetch graph: " + response.status);
            });
          }
          return response.json();
        })
        .then(function (data) {
          var newCommits = (data.data && data.data.commits) || [];
          var hasMoreFromApi = (data.data && data.data.hasMore) || false;

          if (append) {
            // Deduplicate
            var existing = {};
            for (var i = 0; i < state.commits.length; i++) {
              existing[state.commits[i].hash] = true;
            }
            var unique = [];
            for (var j = 0; j < newCommits.length; j++) {
              if (!existing[newCommits[j].hash]) {
                unique.push(newCommits[j]);
              }
            }
            state.commits = state.commits.concat(unique);
          } else {
            state.commits = newCommits;
          }

          state.layout = calculateGraphLayout(state.commits);
          state.loading = false;
          state.loadingMore = false;
          state.error = null;
          state.hasMore = hasMoreFromApi;
          state.skip = skip + newCommits.length;

          render();
        })
        .catch(function (err) {
          state.loading = false;
          state.loadingMore = false;
          state.error = err.message || "Failed to fetch git graph";
          render();
        });
    }

    // Initial fetch
    fetchCommits(0, false);
  }

  // ── Public API ──────────────────────────────────────────────────────────
  window.GitGraph = {
    init: init,
  };
})();
