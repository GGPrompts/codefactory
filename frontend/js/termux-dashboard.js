/**
 * termux-dashboard.js — Termux API widget dashboard
 *
 * Vanilla JS IIFE module. Renders battery, WiFi, volume, brightness,
 * torch, and TTS widgets. Auto-refreshes battery + WiFi every 30 s.
 */
(function () {
  "use strict";

  var REFRESH_INTERVAL = 30000; // 30 seconds
  var refreshTimer = null;

  // ── API helpers ────────────────────────────────────────────────────

  function apiGet(path, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", path);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(null, JSON.parse(xhr.responseText)); }
        catch (e) { cb(e, null); }
      } else {
        try {
          var body = JSON.parse(xhr.responseText);
          cb(body.error || ("HTTP " + xhr.status), null);
        } catch (_) {
          cb("HTTP " + xhr.status, null);
        }
      }
    };
    xhr.onerror = function () { cb("Network error", null); };
    xhr.send();
  }

  function apiPost(path, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(null, JSON.parse(xhr.responseText)); }
        catch (e) { cb(e, null); }
      } else {
        try {
          var parsed = JSON.parse(xhr.responseText);
          cb(parsed.error || ("HTTP " + xhr.status), null);
        } catch (_) {
          cb("HTTP " + xhr.status, null);
        }
      }
    };
    xhr.onerror = function () { cb("Network error", null); };
    xhr.send(JSON.stringify(body));
  }

  // ── Widget renderers ──────────────────────────────────────────────

  function setStatus(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function setError(id, msg) {
    setStatus(id, '<span class="tx-error">' + escapeHtml(String(msg)) + "</span>");
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  // ── Battery ───────────────────────────────────────────────────────

  function refreshBattery() {
    setStatus("battery-body", '<span class="tx-loading">polling...</span>');
    apiGet("/api/termux/battery", function (err, data) {
      if (err) return setError("battery-body", err);

      var pct = data.percentage != null ? data.percentage : "?";
      var health = data.health || "UNKNOWN";
      var status = data.status || "UNKNOWN";
      var temp = data.temperature != null ? data.temperature + "\u00B0C" : "?";
      var plugged = data.plugged || "UNKNOWN";

      var gaugeClass = "tx-gauge-fill";
      if (pct <= 20) gaugeClass += " tx-gauge-low";
      else if (pct >= 80) gaugeClass += " tx-gauge-high";

      var html = "";
      html += '<div class="tx-gauge"><div class="' + gaugeClass + '" style="width:' + Math.min(pct, 100) + '%"></div></div>';
      html += '<div class="tx-stat-row"><span class="tx-label">LEVEL</span><span class="tx-value">' + pct + "%</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">STATUS</span><span class="tx-value">' + escapeHtml(status) + "</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">HEALTH</span><span class="tx-value">' + escapeHtml(health) + "</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">TEMP</span><span class="tx-value">' + escapeHtml(temp) + "</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">PLUGGED</span><span class="tx-value">' + escapeHtml(plugged) + "</span></div>";

      setStatus("battery-body", html);
    });
  }

  // ── WiFi ──────────────────────────────────────────────────────────

  function refreshWifi() {
    setStatus("wifi-body", '<span class="tx-loading">polling...</span>');
    apiGet("/api/termux/wifi", function (err, data) {
      if (err) return setError("wifi-body", err);

      var ssid = data.ssid || "N/A";
      var ip = data.ip || "N/A";
      var rssi = data.rssi != null ? data.rssi + " dBm" : "?";
      var speed = data.link_speed_mbps != null ? data.link_speed_mbps + " Mbps" : "?";
      var freq = data.frequency_mhz != null ? data.frequency_mhz + " MHz" : "?";

      // Signal strength icon (rough mapping)
      var bars = 0;
      if (data.rssi != null) {
        if (data.rssi >= -50) bars = 4;
        else if (data.rssi >= -60) bars = 3;
        else if (data.rssi >= -70) bars = 2;
        else bars = 1;
      }
      var barIcons = "";
      for (var i = 0; i < 4; i++) {
        barIcons += '<span class="tx-bar' + (i < bars ? " tx-bar-active" : "") + '"></span>';
      }

      var html = "";
      html += '<div class="tx-signal-bars">' + barIcons + "</div>";
      html += '<div class="tx-stat-row"><span class="tx-label">SSID</span><span class="tx-value">' + escapeHtml(ssid) + "</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">IP</span><span class="tx-value tx-mono">' + escapeHtml(ip) + "</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">SIGNAL</span><span class="tx-value">' + escapeHtml(rssi) + "</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">SPEED</span><span class="tx-value">' + escapeHtml(speed) + "</span></div>";
      html += '<div class="tx-stat-row"><span class="tx-label">FREQ</span><span class="tx-value">' + escapeHtml(freq) + "</span></div>";

      setStatus("wifi-body", html);
    });
  }

  // ── Volume ────────────────────────────────────────────────────────

  function refreshVolume() {
    setStatus("volume-body", '<span class="tx-loading">polling...</span>');
    apiGet("/api/termux/volume", function (err, data) {
      if (err) return setError("volume-body", err);

      // data is an array of stream objects
      var streams = Array.isArray(data) ? data : [];
      if (streams.length === 0) {
        return setStatus("volume-body", '<span class="tx-muted">No audio streams</span>');
      }

      var html = "";
      streams.forEach(function (s) {
        var name = s.stream || s.name || "unknown";
        var val = s.volume != null ? s.volume : (s.value != null ? s.value : 0);
        var max = s.max_volume != null ? s.max_volume : (s.max_value != null ? s.max_value : 15);
        var pct = max > 0 ? Math.round((val / max) * 100) : 0;

        html += '<div class="tx-volume-stream">';
        html += '<span class="tx-label">' + escapeHtml(name.toUpperCase()) + "</span>";
        html += '<div class="tx-slider-row">';
        html += '<input type="range" class="tx-slider" min="0" max="' + max + '" value="' + val + '" data-stream="' + escapeHtml(name) + '" disabled>';
        html += '<span class="tx-value tx-mono">' + val + "/" + max + "</span>";
        html += "</div></div>";
      });

      setStatus("volume-body", html);
    });
  }

  // ── Brightness ────────────────────────────────────────────────────

  function initBrightness() {
    var slider = document.getElementById("brightness-slider");
    var display = document.getElementById("brightness-value");
    if (!slider || !display) return;

    slider.addEventListener("input", function () {
      display.textContent = slider.value;
    });

    slider.addEventListener("change", function () {
      var val = parseInt(slider.value, 10);
      display.textContent = val;
      apiPost("/api/termux/brightness", { value: val }, function (err) {
        if (err) {
          setError("brightness-status", err);
        } else {
          setStatus("brightness-status", '<span class="tx-ok">SET</span>');
          setTimeout(function () { setStatus("brightness-status", ""); }, 2000);
        }
      });
    });
  }

  // ── Torch ─────────────────────────────────────────────────────────

  function initTorch() {
    var btn = document.getElementById("torch-toggle");
    if (!btn) return;

    var torchOn = false;

    btn.addEventListener("click", function () {
      torchOn = !torchOn;
      btn.textContent = torchOn ? "TORCH: ON" : "TORCH: OFF";
      btn.className = "tx-torch-btn" + (torchOn ? " tx-torch-on" : "");

      apiPost("/api/termux/torch", { enabled: torchOn }, function (err) {
        if (err) {
          torchOn = !torchOn; // revert
          btn.textContent = torchOn ? "TORCH: ON" : "TORCH: OFF";
          btn.className = "tx-torch-btn" + (torchOn ? " tx-torch-on" : "");
          setError("torch-status", err);
        }
      });
    });
  }

  // ── TTS ───────────────────────────────────────────────────────────

  function initTts() {
    var input = document.getElementById("tts-input");
    var btn = document.getElementById("tts-speak");
    if (!input || !btn) return;

    btn.addEventListener("click", function () {
      var text = input.value.trim();
      if (!text) return;

      btn.disabled = true;
      btn.textContent = "SPEAKING...";

      apiPost("/api/termux/tts", { text: text }, function (err) {
        btn.disabled = false;
        btn.textContent = "SPEAK";
        if (err) {
          setError("tts-status", err);
        } else {
          setStatus("tts-status", '<span class="tx-ok">Sent to TTS</span>');
          setTimeout(function () { setStatus("tts-status", ""); }, 3000);
        }
      });
    });

    // Enter key to speak
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") btn.click();
    });
  }

  // ── Init ──────────────────────────────────────────────────────────

  function refreshAll() {
    refreshBattery();
    refreshWifi();
    refreshVolume();
  }

  function init() {
    refreshAll();
    initBrightness();
    initTorch();
    initTts();

    // Auto-refresh battery and WiFi every 30 s
    refreshTimer = setInterval(function () {
      refreshBattery();
      refreshWifi();
    }, REFRESH_INTERVAL);

    // Manual refresh button
    var refreshBtn = document.getElementById("tx-refresh-all");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", refreshAll);
    }
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
