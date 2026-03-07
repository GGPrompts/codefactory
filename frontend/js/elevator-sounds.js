// ==============================================================
// ELEVATOR SOUNDS (Web Audio API)
// ==============================================================
var ElevatorSounds = (function() {
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

    function playDing() {
        // Industrial clunk: short filtered noise burst (like a heavy relay engaging)
        if (!audioUnlocked) return;
        ensureAudio();
        var now = audioCtx.currentTime;
        var bufferSize = audioCtx.sampleRate * 0.08;
        var buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        var data = buffer.getChannelData(0);
        for (var i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
        }
        var noise = audioCtx.createBufferSource();
        noise.buffer = buffer;

        var filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 220;
        filter.Q.value = 3;

        var gain = audioCtx.createGain();
        gain.gain.setValueAtTime(sfxVolume * 0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        noise.start(now);
        noise.stop(now + 0.08);
    }

    function playClick() {
        // Subtle relay tick: tiny noise pop
        if (!audioUnlocked) return;
        ensureAudio();
        var now = audioCtx.currentTime;
        var bufferSize = audioCtx.sampleRate * 0.02;
        var buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        var data = buffer.getChannelData(0);
        for (var i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.08));
        }
        var noise = audioCtx.createBufferSource();
        noise.buffer = buffer;

        var filter = audioCtx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 800;

        var gain = audioCtx.createGain();
        gain.gain.setValueAtTime(sfxVolume * 0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.02);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        noise.start(now);
        noise.stop(now + 0.02);
    }

    function unlockAudio() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        ensureAudio();
        document.removeEventListener('click', unlockAudio);
        document.removeEventListener('touchstart', unlockAudio);
        document.removeEventListener('keydown', unlockAudio);
    }
    document.addEventListener('click', unlockAudio);
    document.addEventListener('touchstart', unlockAudio);
    document.addEventListener('keydown', unlockAudio);

    return {
        ensureAudio: ensureAudio,
        playDing: playDing,
        playClick: playClick,
        unlockAudio: unlockAudio
    };
})();
