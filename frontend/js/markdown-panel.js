/* ==============================================================
   CodeFactory -- Markdown Side Panel Renderer
   Initializes marked.js with highlight.js and adds copy buttons.
   ============================================================== */
var MarkdownPanel = (function () {
    'use strict';

    var initialized = false;
    var panelCache = {};  // panelName -> rendered HTML string

    /**
     * Initialize marked with highlight.js integration.
     * Safe to call multiple times; only runs once.
     */
    function init() {
        if (initialized) return;
        if (typeof marked === 'undefined') {
            console.warn('[MarkdownPanel] marked.js not loaded');
            return;
        }

        var renderer = new marked.Renderer();

        // Custom heading renderer -- add IDs for anchor links
        renderer.heading = function (data) {
            var raw = data.text.toLowerCase().replace(/[^\w]+/g, '-');
            return '<h' + data.depth + ' id="' + raw + '">' + data.text + '</h' + data.depth + '>';
        };

        marked.setOptions({
            renderer: renderer,
            gfm: true,
            breaks: false,
            pedantic: false,
            highlight: function (code, lang) {
                if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                    try {
                        return hljs.highlight(code, { language: lang }).value;
                    } catch (e) { /* fall through */ }
                }
                if (typeof hljs !== 'undefined') {
                    try {
                        return hljs.highlightAuto(code).value;
                    } catch (e) { /* fall through */ }
                }
                return code;
            },
        });

        initialized = true;
        console.log('[MarkdownPanel] Initialized');
    }

    /**
     * Render raw markdown string to HTML and inject into a container.
     * Adds copy-to-clipboard buttons to all code blocks.
     *
     * @param {HTMLElement} container - Target element to fill
     * @param {string} markdown - Raw markdown text
     */
    function render(container, markdown) {
        init();

        if (!container || !markdown) return;

        var html = marked.parse(markdown);
        container.innerHTML = '<div class="prose">' + html + '</div>';

        // Post-process: wrap code blocks and add copy buttons
        addCopyButtons(container);
    }

    /**
     * Fetch markdown from /api/panels/:name, render, and inject.
     * Caches the rendered result for subsequent calls.
     *
     * @param {HTMLElement} container - Target element
     * @param {string} panelName - Filename (e.g. "claude.md")
     * @param {boolean} [forceRefresh] - Bypass cache
     */
    function load(container, panelName, forceRefresh) {
        if (!container || !panelName) return;

        // Check cache
        if (!forceRefresh && panelCache[panelName]) {
            container.innerHTML = '<div class="prose">' + panelCache[panelName] + '</div>';
            addCopyButtons(container);
            return;
        }

        // Show loading state
        container.innerHTML =
            '<div class="panel-loading">' +
            '<span class="panel-loading-text">LOADING PANEL...</span>' +
            '</div>';

        fetch('/api/panels/' + encodeURIComponent(panelName))
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(function (markdown) {
                init();
                var html = marked.parse(markdown);
                panelCache[panelName] = html;
                container.innerHTML = '<div class="prose">' + html + '</div>';
                addCopyButtons(container);
            })
            .catch(function (err) {
                console.warn('[MarkdownPanel] Failed to load panel "' + panelName + '":', err);
                container.innerHTML =
                    '<div class="panel-error">' +
                    '<span class="panel-error-text">PANEL NOT FOUND</span>' +
                    '<span class="panel-error-detail">' + escapeHtml(panelName) + '</span>' +
                    '</div>';
            });
    }

    /**
     * Wrap all <pre> blocks in a wrapper div and add a copy button.
     * @param {HTMLElement} container
     */
    function addCopyButtons(container) {
        var pres = container.querySelectorAll('pre');
        pres.forEach(function (pre) {
            // Skip if already wrapped
            if (pre.parentElement && pre.parentElement.classList.contains('code-block-wrapper')) return;

            var wrapper = document.createElement('div');
            wrapper.className = 'code-block-wrapper';
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);

            var btn = document.createElement('button');
            btn.className = 'code-copy-btn';
            btn.textContent = 'COPY';
            btn.addEventListener('click', function () {
                var code = pre.querySelector('code');
                var text = code ? code.textContent : pre.textContent;
                copyToClipboard(text, btn);
            });
            wrapper.appendChild(btn);
        });
    }

    /**
     * Copy text to clipboard and show feedback on button.
     * @param {string} text
     * @param {HTMLElement} btn
     */
    function copyToClipboard(text, btn) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showCopied(btn);
            }).catch(function () {
                fallbackCopy(text, btn);
            });
        } else {
            fallbackCopy(text, btn);
        }
    }

    function fallbackCopy(text, btn) {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showCopied(btn);
        } catch (e) {
            console.warn('[MarkdownPanel] Copy failed:', e);
        }
        document.body.removeChild(textarea);
    }

    function showCopied(btn) {
        btn.textContent = 'COPIED';
        btn.classList.add('copied');
        setTimeout(function () {
            btn.textContent = 'COPY';
            btn.classList.remove('copied');
        }, 2000);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Clear the cache for a specific panel or all panels.
     * @param {string} [panelName] - If omitted, clears entire cache
     */
    function clearCache(panelName) {
        if (panelName) {
            delete panelCache[panelName];
        } else {
            panelCache = {};
        }
    }

    return {
        init: init,
        render: render,
        load: load,
        clearCache: clearCache,
    };
})();
