// LiveReload — hot-swap CSS, refresh page iframes (no full reload)
(function () {
    var ws = null;
    var reconnectTimer = null;

    function connect() {
        var protocol = location.protocol === "https:" ? "wss:" : "ws:";
        var url = protocol + "//" + location.host + "/ws/livereload";
        ws = new WebSocket(url);

        ws.onopen = function () {
            console.log("[LiveReload] Connected");
        };

        ws.onmessage = function (ev) {
            var msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (e) {
                return;
            }
            if (msg.type !== "file-changed") return;

            var changeType = msg.change_type;
            var path = msg.path;
            console.log("[LiveReload] " + changeType + ": " + path);

            if (changeType === "css") {
                hotSwapCSS();
            } else if (changeType === "page") {
                reloadPageIframe(path);
            } else if (changeType === "js" || changeType === "html") {
                console.info("[LiveReload] " + path + " changed — refresh page to pick up changes");
            }
        };

        ws.onclose = function () {
            console.log("[LiveReload] Disconnected, reconnecting in 5s...");
            scheduleReconnect();
        };

        ws.onerror = function () {
            // onclose will fire after this
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            connect();
        }, 5000);
    }

    function hotSwapCSS() {
        var links = document.querySelectorAll('link[rel="stylesheet"]');
        var bust = "_lr=" + Date.now();
        for (var i = 0; i < links.length; i++) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (!href || href.indexOf("//") !== -1) continue; // skip CDN
            // Strip old cache-bust param
            href = href.replace(/[?&]_lr=\d+/, "");
            var sep = href.indexOf("?") === -1 ? "?" : "&";
            link.setAttribute("href", href + sep + bust);
        }
    }

    function reloadPageIframe(changedPath) {
        // changedPath looks like "frontend/pages/git.html"
        // iframe src looks like "/api/pages/git.html"
        var iframes = document.querySelectorAll("iframe.page-iframe");
        for (var i = 0; i < iframes.length; i++) {
            var iframe = iframes[i];
            var src = iframe.getAttribute("src") || "";
            // Extract the page filename from the changed path
            var pageFile = changedPath.replace(/^frontend\/pages\//, "");
            if (src.indexOf(pageFile) !== -1) {
                // Reload this iframe by resetting src
                var base = src.replace(/[?&]_lr=\d+/, "");
                var sep = base.indexOf("?") === -1 ? "?" : "&";
                iframe.setAttribute("src", base + sep + "_lr=" + Date.now());
                console.log("[LiveReload] Reloaded iframe: " + pageFile);
                return;
            }
        }
    }

    connect();
})();
