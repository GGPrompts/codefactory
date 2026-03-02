// CodeFactory Console Forwarder
// Intercepts console.log/warn/error/info and window.onerror,
// batches them, and POSTs to /api/logs/ingest every 500ms.
(function() {
  var FLUSH_MS = 500;
  var INGEST_URL = '/api/logs/ingest';

  var queue = [];
  var origLog   = console.log.bind(console);
  var origWarn  = console.warn.bind(console);
  var origError = console.error.bind(console);
  var origInfo  = console.info.bind(console);

  function stringify(args) {
    var result = Array.prototype.map.call(args, function(a) {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        var s = JSON.stringify(a);
        return s && s.length > 200 ? s.substring(0, 200) + '...' : s;
      } catch(e) { return String(a); }
    }).join(' ');
    return result.length > 500 ? result.substring(0, 500) + '...' : result;
  }

  function enqueue(level, args, stack) {
    queue.push({
      level: level,
      source: 'js',
      message: stringify(args),
      stack: stack || null,
      timestamp: new Date().toISOString()
    });
    if (level === 'error') flush();
  }

  console.log = function() {
    // Skip log level — too noisy. Only warn/error/info forwarded.
    origLog.apply(console, arguments);
  };

  console.warn = function() {
    enqueue('warn', arguments, null);
    origWarn.apply(console, arguments);
  };

  console.error = function() {
    enqueue('error', arguments, null);
    origError.apply(console, arguments);
  };

  console.info = function() {
    // Skip info level — only warn/error forwarded.
    origInfo.apply(console, arguments);
  };

  window.onerror = function(msg, src, line, col, err) {
    enqueue('error',
      [msg + ' (' + src + ':' + line + ':' + col + ')'],
      err && err.stack ? err.stack : null
    );
    return false;
  };

  window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason;
    var msg = reason instanceof Error ? reason.message : String(reason);
    // Skip fetch failures (service worker noise)
    if (msg === 'Failed to fetch' || msg === 'TypeError: Failed to fetch') return;
    var stack = reason instanceof Error ? reason.stack : null;
    enqueue('error', ['Unhandled rejection: ' + msg], stack);
  });

  function flush() {
    if (queue.length === 0) return;
    var batch = queue.splice(0, queue.length);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', INGEST_URL, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(batch));
  }

  setInterval(flush, FLUSH_MS);
  window.addEventListener('beforeunload', flush);
})();
