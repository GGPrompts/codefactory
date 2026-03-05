/**
 * FilePicker — reusable modal file/directory picker
 *
 * Usage:
 *   FilePicker.open({
 *     mode: 'file' | 'dir',
 *     startPath: '/home/user/projects',
 *     onSelect: function(path) { ... }
 *   });
 */
var FilePicker = (function () {
    "use strict";

    var overlay = null;
    var listEl = null;
    var breadcrumbEl = null;
    var selectBtn = null;
    var currentOpts = null;

    // Navigation state
    var basePath = "";
    var currentDir = "";
    var entries = [];
    var showHidden = false;

    // ── Helpers ──

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function fileIcon(name, isDir) {
        if (isDir) return "\uD83D\uDCC1";
        var ext = name.split(".").pop().toLowerCase();
        var icons = {
            js: "\uD83D\uDCDC", ts: "\uD83D\uDCDC",
            rs: "\uD83E\uDD80", py: "\uD83D\uDC0D",
            html: "\uD83C\uDF10", css: "\uD83C\uDFA8",
            json: "{ }", toml: "\u2699", yaml: "\u2699", yml: "\u2699",
            md: "\uD83D\uDCDD", txt: "\uD83D\uDCDD",
            sh: "\uD83D\uDCBB", bash: "\uD83D\uDCBB"
        };
        return icons[ext] || "\uD83D\uDCC4";
    }

    function currentFullDir() {
        if (!currentDir) return basePath;
        return basePath + "/" + currentDir;
    }

    function joinPath(base, name) {
        if (!base) return name;
        return base + "/" + name;
    }

    // ── XHR ──

    function xhrGet(url, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                try { cb(null, JSON.parse(xhr.responseText)); }
                catch (e) { cb("Invalid JSON"); }
            } else {
                try {
                    var err = JSON.parse(xhr.responseText);
                    cb(err.error || ("HTTP " + xhr.status));
                } catch (e2) { cb("HTTP " + xhr.status); }
            }
        };
        xhr.onerror = function () { cb("Network error"); };
        xhr.send();
    }

    // ── DOM Construction (one-time) ──

    function ensureDOM() {
        if (overlay) return;

        overlay = document.createElement("div");
        overlay.className = "fp-overlay";
        overlay.innerHTML =
            '<div class="fp-modal">' +
                '<div class="fp-header">' +
                    '<button class="fp-header-btn" id="fp-up-btn" title="Go up one level">&#x2B06;</button>' +
                    '<div class="fp-breadcrumb" id="fp-breadcrumb"></div>' +
                    '<button class="fp-header-btn fp-toggle-hidden" id="fp-toggle-hidden" title="Show hidden files">.*</button>' +
                '</div>' +
                '<div class="fp-list" id="fp-list">' +
                    '<div class="fp-loading"><div class="fp-spinner"></div><span>Loading...</span></div>' +
                '</div>' +
                '<div class="fp-footer">' +
                    '<span class="fp-path-display" id="fp-path-display"></span>' +
                    '<div class="fp-footer-actions">' +
                        '<button class="power-btn fp-cancel-btn" id="fp-cancel-btn">[CANCEL]</button>' +
                        '<button class="power-btn fp-select-btn" id="fp-select-btn">[SELECT]</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        listEl = document.getElementById("fp-list");
        breadcrumbEl = document.getElementById("fp-breadcrumb");
        selectBtn = document.getElementById("fp-select-btn");

        // Event: cancel
        document.getElementById("fp-cancel-btn").addEventListener("click", close);

        // Event: backdrop click
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) close();
        });

        // Event: up-level
        document.getElementById("fp-up-btn").addEventListener("click", navigateUpLevel);

        // Event: toggle hidden
        var toggleBtn = document.getElementById("fp-toggle-hidden");
        toggleBtn.addEventListener("click", function () {
            showHidden = !showHidden;
            toggleBtn.classList.toggle("fp-on", showHidden);
            renderFileList();
        });

        // Event: select current directory / file
        selectBtn.addEventListener("click", function () {
            if (currentOpts && currentOpts.onSelect) {
                currentOpts.onSelect(currentFullDir());
            }
            close();
        });

        // Event: escape key
        overlay.addEventListener("keydown", function (e) {
            if (e.key === "Escape") {
                e.stopPropagation();
                close();
            }
        });
    }

    // ── Navigation ──

    function navigateTo(dir) {
        currentDir = dir || "";
        loadDirectory();
    }

    function navigateUpLevel() {
        if (currentDir) {
            var parts = currentDir.split("/");
            parts.pop();
            navigateTo(parts.join("/"));
            return;
        }
        if (basePath === "/") return;
        if (basePath.charAt(0) === "~") {
            xhrGet("/api/files/list?path=" + encodeURIComponent(basePath), function (err, data) {
                if (!err && data.path) {
                    var parent = data.path.replace(/\/[^\/]+\/?$/, "") || "/";
                    basePath = parent;
                    currentDir = "";
                    loadDirectory();
                }
            });
            return;
        }
        var clean = basePath.replace(/\/+$/, "");
        var parent = clean.replace(/\/[^\/]+$/, "") || "/";
        basePath = parent;
        currentDir = "";
        loadDirectory();
    }

    function loadDirectory() {
        listEl.innerHTML = '<div class="fp-loading"><div class="fp-spinner"></div><span>Loading...</span></div>';
        renderBreadcrumb();
        updatePathDisplay();

        var url = "/api/files/list?path=" + encodeURIComponent(basePath);
        if (currentDir) {
            url += "&dir=" + encodeURIComponent(currentDir);
        }

        xhrGet(url, function (err, data) {
            if (err) {
                listEl.innerHTML = '<div class="fp-empty">Error: ' + escapeHtml(err) + '</div>';
                return;
            }
            entries = data.entries || [];
            renderFileList();
        });
    }

    // ── Rendering ──

    function renderBreadcrumb() {
        breadcrumbEl.innerHTML = "";

        var baseDisplay = basePath.replace(/\/+$/, "") || "/";
        var baseSegments = [];
        if (baseDisplay === "/") {
            baseSegments.push({ label: "/", path: "/" });
        } else {
            var bParts = baseDisplay.split("/");
            var bAccum = "";
            for (var b = 0; b < bParts.length; b++) {
                if (b === 0 && bParts[b] === "") {
                    bAccum = "";
                    baseSegments.push({ label: "/", path: "/" });
                } else {
                    bAccum = bAccum ? (bAccum + "/" + bParts[b]) : bParts[b];
                    baseSegments.push({ label: bParts[b], path: bAccum.charAt(0) === "/" || bAccum.charAt(0) === "~" ? bAccum : "/" + bAccum });
                }
            }
        }

        var parts = [];
        for (var s = 0; s < baseSegments.length; s++) {
            parts.push({ label: baseSegments[s].label, basePath: baseSegments[s].path, dir: "" });
        }
        if (currentDir) {
            var segments = currentDir.split("/");
            var accum = "";
            for (var i = 0; i < segments.length; i++) {
                accum = accum ? (accum + "/" + segments[i]) : segments[i];
                parts.push({ label: segments[i], basePath: basePath, dir: accum });
            }
        }

        for (var j = 0; j < parts.length; j++) {
            if (j > 0) {
                var sep = document.createElement("span");
                sep.className = "fp-crumb-sep";
                sep.textContent = "/";
                breadcrumbEl.appendChild(sep);
            }
            var btn = document.createElement("button");
            btn.className = "fp-crumb";
            btn.textContent = parts[j].label;
            if (j === parts.length - 1) {
                btn.classList.add("fp-crumb-current");
            }
            btn.setAttribute("data-base", parts[j].basePath);
            btn.setAttribute("data-dir", parts[j].dir);
            btn.addEventListener("click", function () {
                var newBase = this.getAttribute("data-base");
                var newDir = this.getAttribute("data-dir");
                basePath = newBase;
                currentDir = newDir;
                loadDirectory();
            });
            breadcrumbEl.appendChild(btn);
        }
        breadcrumbEl.scrollLeft = breadcrumbEl.scrollWidth;
    }

    function renderFileList() {
        listEl.innerHTML = "";

        // Parent directory link
        if (currentDir) {
            var parentItem = document.createElement("div");
            parentItem.className = "fp-item";
            parentItem.innerHTML = '<span class="fp-item-icon">\u2B06</span>' +
                '<span class="fp-item-name fp-item-name-dir">..</span>';
            parentItem.addEventListener("click", function () {
                var parts = currentDir.split("/");
                parts.pop();
                navigateTo(parts.join("/"));
            });
            listEl.appendChild(parentItem);
        }

        var visible = entries.filter(function (e) {
            if (!showHidden && e.name.charAt(0) === ".") return false;
            return true;
        });

        var mode = currentOpts ? currentOpts.mode : "dir";

        // In dir mode, show only dirs. In file mode, show all.
        var filtered = visible;
        if (mode === "dir") {
            filtered = visible.filter(function (e) { return e.is_dir; });
        }

        if (filtered.length === 0) {
            var empty = document.createElement("div");
            empty.className = "fp-empty";
            if (mode === "dir") {
                empty.textContent = visible.length > filtered.length ? "No subdirectories here" : "Empty directory";
            } else {
                empty.textContent = entries.length > 0 ? "All files hidden (toggle .* to show)" : "Empty directory";
            }
            listEl.appendChild(empty);
            return;
        }

        for (var i = 0; i < filtered.length; i++) {
            listEl.appendChild(buildItem(filtered[i]));
        }
    }

    function buildItem(entry) {
        var div = document.createElement("div");
        div.className = "fp-item";

        var icon = document.createElement("span");
        icon.className = "fp-item-icon";
        icon.textContent = fileIcon(entry.name, entry.is_dir);

        var name = document.createElement("span");
        name.className = "fp-item-name";
        if (entry.is_dir) name.classList.add("fp-item-name-dir");
        name.textContent = entry.name;

        div.appendChild(icon);
        div.appendChild(name);

        div.addEventListener("click", function () {
            if (entry.is_dir) {
                navigateTo(joinPath(currentDir, entry.name));
            } else {
                // File mode: select this file
                if (currentOpts && currentOpts.mode === "file" && currentOpts.onSelect) {
                    currentOpts.onSelect(currentFullDir() + "/" + entry.name);
                }
                close();
            }
        });

        return div;
    }

    function updatePathDisplay() {
        var display = document.getElementById("fp-path-display");
        if (display) {
            display.textContent = currentFullDir();
        }
    }

    // ── Public API ──

    function open(opts) {
        currentOpts = opts || {};
        basePath = currentOpts.startPath || "~";
        currentDir = "";
        showHidden = false;
        entries = [];

        ensureDOM();

        // Update select button label based on mode
        if (currentOpts.mode === "dir") {
            selectBtn.textContent = "[SELECT DIR]";
            selectBtn.style.display = "";
        } else {
            // In file mode, select button is hidden — user clicks a file directly
            selectBtn.style.display = "none";
        }

        // Reset hidden toggle
        var toggleBtn = document.getElementById("fp-toggle-hidden");
        if (toggleBtn) toggleBtn.classList.remove("fp-on");

        overlay.classList.add("fp-visible");
        document.body.style.overflow = "hidden";
        loadDirectory();
    }

    function close() {
        if (overlay) {
            overlay.classList.remove("fp-visible");
        }
        document.body.style.overflow = "";
        currentOpts = null;
    }

    return {
        open: open,
        close: close
    };
})();
