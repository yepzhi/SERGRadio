import { Howl, Howler } from 'howler';

export const radio = new class RadioEngine {
    constructor() {
        this.streamUrl = 'https://yepzhi-sergradio-sync.hf.space/stream';
        this.howl = null;
        this.isPlaying = false;
        this.volume = 1.0;

        // Hooks
        this.onPlay = null;
        this.onLoadStart = null;
        this.onTrackChange = null;

        // Audio Graph
        this.context = null;
        this.analyser = null;
        this.dataArray = null;

        this.watchdogInterval = null;
        this.onBufferingChange = null; // UI Hook
        this.onNetworkStats = null; // New UI Hook for real data usage

        // Network Stats State
        this.lastBufferedParams = { end: 0, total: 0 };
        this.sessionTotalBytes = 0;

        // Silence Detection
        this.silenceStartTime = null;
        this.silenceMonitorId = null;
    }

    reconnect() {
        console.warn("RadioEngine: Manual/Forced Reconnect");
        if (this.onBufferingChange) this.onBufferingChange(true);
        this.pause();
        setTimeout(() => this.play(), 100);
    }

    async init() {
        console.log("RadioEngine: Initializing Stream Mode");
        // Initial fake metadata
        this._updateMetadata();
    }

    _updateMetadata() {
        if (this.onTrackChange) {
            this.onTrackChange({
                title: "Live Radio",
                artist: "SERGRadio",
                src: this.streamUrl,
                type: "stream",
                id: "stream"
            });
        }
    }

    play() {
        if (this.isPlaying) return;

        console.log("RadioEngine: Starting Stream...");
        if (this.onLoadStart) this.onLoadStart();

        // CRITICAL: Unlock AudioContext BEFORE creating Howl (Chrome/Firefox fix)
        this._unlockAudioContext();

        // 1. Unload previous instance to ensure fresh live edge
        if (this.howl) {
            this.howl.unload();
        }

        // 2. Create new Howl instance
        this.howl = new Howl({
            src: [this.streamUrl + '?t=' + Date.now()],
            format: ['mp3'],
            html5: true, // Required for long streams & iOS background audio
            volume: this.volume,
            autoplay: false, // We handle play manually to inject CORS
            onplay: () => {
                console.log("RadioEngine: Stream Playing!");
                this.isPlaying = true;
                if (this.onPlay) this.onPlay();
                this._setupMediaSession();
                this._connectVisualizer();
            },
            onloaderror: (id, err) => {
                console.error("RadioEngine: Stream Connection Error", err);
                // Simple retry
                setTimeout(() => this.play(), 2000);
            },
            onplayerror: (id, err) => {
                console.warn("RadioEngine: Play blocked by browser, retrying...", err);
                // Force unlock and retry
                this._unlockAudioContext();
                setTimeout(() => {
                    if (this.howl) this.howl.play();
                }, 100);
            },
            onend: () => {
                console.log("RadioEngine: Stream ended (connection lost?)");
                this.isPlaying = false;
                // Auto-reconnect
                setTimeout(() => this.play(), 1000);
            }
        });

        // 3. Inject CORS *before* request starts (Critical for Chrome/Firefox Visualizer)
        if (this.howl._sounds.length > 0 && this.howl._sounds[0]._node) {
            this.howl._sounds[0]._node.crossOrigin = "anonymous";
        }

        // 4. Start
        // 4. Start
        this.howl.play();

        // 5. Start Watchdog
        this._startBufferingWatchdog();
        // 6. Start Silence Monitor
        this._startSilenceMonitor();
    }

    _startBufferingWatchdog() {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

        let stuckTime = 0;
        let lastTime = -1;

        this.watchdogInterval = setInterval(() => {
            if (!this.howl || !this.isPlaying) return;

            const sound = this.howl._sounds[0];
            const node = sound ? sound._node : null;

            if (!node || node.paused) return; // Don't check if intentionally paused

            const currentTime = node.currentTime;

            // Condition: Time hasn't moved significant amount
            if (Math.abs(currentTime - lastTime) < 0.05) {
                stuckTime += 1000;
                // Notify UI: Buffering
                if (stuckTime >= 1000) { // Only show buffering if stuck > 1s
                    if (this.onBufferingChange) this.onBufferingChange(true);
                }
            } else {
                // Recovered
                if (stuckTime > 0) {
                    if (this.onBufferingChange) this.onBufferingChange(false);
                }
                stuckTime = 0;
            }

            lastTime = currentTime;

            // TRIGGER: Force Reconnect if stuck > 5s
            // DISABLED by user request (v2.7.4) - avoids jumps/restarts
            /*
            if (stuckTime > 5000) {
                console.warn("RadioEngine: Watchdog triggered! Stream stuck > 5s. force reconnecting...");
                stuckTime = 0;

                // CRITICAL: Clean stop to reset isPlaying state so play() works
                this.pause();

                setTimeout(() => this.play(), 100); // Re-init
            }
            */

            // --- REAL NETWORK CONSUMPTION TRACKING (v2.8.4) ---
            try {
                // Calculate total buffered duration
                let totalBuffered = 0;
                const ranges = node.buffered;
                for (let i = 0; i < ranges.length; i++) {
                    totalBuffered += (ranges.end(i) - ranges.start(i));
                }

                // Delta = New audio downloaded this second (approx)
                // Note: 'totalBuffered' grows as we download, but implies we have the data.
                // However, since we play it, it might get evicted? No, usually kept until full.
                // Better metric: 'buffered.end(ranges.length-1)' tracks the leading edge.

                // Let's use the leading edge of the last buffer range
                let leadingEdge = 0;
                if (ranges.length > 0) {
                    leadingEdge = ranges.end(ranges.length - 1);
                }

                // If leading edge moved 5s, we downloaded 5s of audio (burst).
                // If it moved 1s, we downloaded 1s (steady).

                let secondsDownloaded = 0;
                if (this.lastBufferedParams.end > 0) {
                    secondsDownloaded = leadingEdge - this.lastBufferedParams.end;
                }

                // Handling seek/reset: if negative, ignore
                if (secondsDownloaded < 0) secondsDownloaded = 0;

                // Calculate Bytes (320kbps = 40KB/s)
                const bytesDownloaded = secondsDownloaded * 40000;
                this.sessionTotalBytes += bytesDownloaded;

                // Update State
                this.lastBufferedParams.end = leadingEdge;

                // Callback
                if (this.onNetworkStats) {
                    this.onNetworkStats({
                        speed: bytesDownloaded, // Bytes per second
                        total: this.sessionTotalBytes
                    });
                }
            } catch (e) {
                // Ignore buffer errors
            }

        }, 1000);
    }

    _startSilenceMonitor() {
        if (this.silenceMonitorId) cancelAnimationFrame(this.silenceMonitorId);

        const monitor = () => {
            if (!this.isPlaying) {
                this.silenceMonitorId = null;
                return;
            }

            const data = this.getAudioData();
            if (data) {
                const avg = data.reduce((a, b) => a + b, 0) / data.length;

                if (avg < 3) {
                    if (!this.silenceStartTime) {
                        this.silenceStartTime = Date.now();
                    } else if (Date.now() - this.silenceStartTime > 5000) {
                        console.warn("RadioEngine: Silence detected (>5s)");
                        this.silenceStartTime = null;
                        // this.reconnect(); // DISABLED (v2.7.4)
                        return;
                    }
                } else {
                    this.silenceStartTime = null;
                }
            }
            this.silenceMonitorId = requestAnimationFrame(monitor);
        };
        this.silenceMonitorId = requestAnimationFrame(monitor);
    }

    _unlockAudioContext() {
        // Force resume Howler's AudioContext
        if (Howler.ctx) {
            if (Howler.ctx.state === 'suspended') {
                console.log("RadioEngine: Resuming suspended AudioContext...");
                Howler.ctx.resume().then(() => {
                    console.log("RadioEngine: AudioContext resumed!");
                }).catch(e => {
                    console.warn("RadioEngine: AudioContext resume failed:", e);
                });
            }
        }

        // Howler internal unlock (belt and suspenders)
        if (typeof Howler._autoResume === 'function') {
            Howler._autoResume();
        }
    }


    pause() {
        console.log("RadioEngine: Stopping Stream");
        if (this.howl) {
            this.howl.unload(); // Truly stop to save bandwidth
            this.howl = null;
        }
        this.isPlaying = false;
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    }

    setVolume(val) {
        this.volume = val;
        if (this.howl) this.howl.volume(val);
    }

    resumeContext() {
        if (Howler.ctx && Howler.ctx.state === 'suspended') {
            Howler.ctx.resume();
        }
    }

    getAudioData() {
        if (this.analyser && this.dataArray) {
            this.analyser.getByteFrequencyData(this.dataArray);
            return this.dataArray;
        }
        return null;
    }

    _connectVisualizer() {
        if (!Howler.ctx) return;
        const ctx = Howler.ctx;

        // Ensure Analyser exists
        if (!this.analyser) {
            this.analyser = ctx.createAnalyser();
            this.analyser.fftSize = 64; // Low res for performance
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        }

        // Hook into Howler HTML5 Audio Node for Visualizer AND EQ
        try {
            if (this.howl && this.howl._sounds.length > 0) {
                const node = this.howl._sounds[0]._node;
                if (node) {
                    node.crossOrigin = "anonymous";
                    if (!node._source) {
                        const source = ctx.createMediaElementSource(node);

                        // --- CONNECT GRAPH (Simplified v2.9.6) ---
                        // Backend now handles EQ/Compression. Client just visualizes.
                        // Source -> Analyser -> Out
                        source.connect(this.analyser);
                        this.analyser.connect(ctx.destination);

                        node._source = source; // Cache it
                    }
                }
            }
        } catch (e) {
            console.warn("Audio Graph connect failed (CORS?):", e);
        }
    }

    _setupMediaSession() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: "Live Stream",
                artist: "SERGRadio",
                artwork: [{ src: 'https://yepzhi.com/SERGRadio/logo.svg', sizes: '512x512', type: 'image/svg+xml' }]
            });
            navigator.mediaSession.playbackState = 'playing';
            navigator.mediaSession.setActionHandler('play', () => this.play());
            navigator.mediaSession.setActionHandler('pause', () => this.pause());
        }
    }
};
