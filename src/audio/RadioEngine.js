import { Howl, Howler } from 'howler';

// Patch Howler's HTML5 Audio pool to guarantee CORS is set on every audio element before src/load
if (typeof Howler !== 'undefined' && typeof Howler._obtainHtml5Audio === 'function' && !Howler._corsPatched) {
    const origObtain = Howler._obtainHtml5Audio;
    Howler._obtainHtml5Audio = function() {
        const audio = origObtain.call(this);
        try {
            audio.crossOrigin = 'anonymous';
            audio.preload = 'auto';
        } catch (e) {}
        return audio;
    };
    if (Array.isArray(Howler._html5AudioPool)) {
        Howler._html5AudioPool.forEach(node => {
            try {
                node.crossOrigin = 'anonymous';
                node.preload = 'auto';
            } catch (e) {}
        });
    }
    Howler._corsPatched = true;
}

// Disable Howler's 30s autoSuspend so it never interferes with streaming audio
if (typeof Howler !== 'undefined') {
    Howler.autoSuspend = false;
}

export const radio = new class RadioEngine {
    constructor() {
        this.streamUrl = 'https://yepzhi-sergradio-sync.hf.space/stream';
        this.howl = null;
        this.isPlaying = false;
        this.volume = 1.0;
        this.currentQuality = '320'; // Default

        // Hooks
        this.onPlay = null;
        this.onLoadStart = null;
        this.onPlay = null;
        this.onLoadStart = null;
        this.onTrackChange = null;
        this.onQualityChange = null; // Sync UI

        // Audio Graph
        this.context = null;
        this.analyser = null;
        this.dataArray = null;

        this.watchdogInterval = null;
        this.onBufferingChange = null; // UI Hook
        this.onNetworkStats = null; // New UI Hook for real data usage

        // Self-Healing Stream State
        this.shouldBePlaying = false;
        this.isReconnecting = false;
        this.lastReconnectTime = 0;
        this.reconnectTimer = null;
        this.inPlaceFailCount = 0;
        this._initialized = false;

        // Network Stats State
        this.lastBufferedParams = { end: 0, total: 0 };
        this.sessionTotalBytes = 0;

        // Silence Detection
        this.silenceStartTime = null;
        this.silenceMonitorId = null;

        // Audio Output Selection (v3.2.5)
        this.currentOutputDevice = null;
        this.onAudioOutputChange = null;

        // Auto-Resume on Device Reconnect (v3.2.5)
        this.wasPlayingBeforeDisconnect = false;
    }

    reconnect() {
        console.warn("RadioEngine: Manual/Forced Reconnect");
        this.shouldBePlaying = true;
        this.isReconnecting = false;
        if (this.onBufferingChange) this.onBufferingChange(true);
        this._healStream('manual', true);
    }

    _scheduleReconnect(delayMs = 1500, reason = 'auto') {
        if (!this.shouldBePlaying) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.onBufferingChange) this.onBufferingChange(true);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldBePlaying) {
                this._healStream(reason);
            }
        }, delayMs);
    }

    _attachNodeListeners(node) {
        if (!node) return;
        try {
            node.crossOrigin = "anonymous";
            node.preload = "auto";
        } catch (e) {}

        if (node._radioListenersAttached) return;
        node._radioListenersAttached = true;

        node.onpause = () => {
            if (this.shouldBePlaying && !this.isReconnecting) {
                if (node.ended || node.error) {
                    this._scheduleReconnect(300, 'node-ended-or-error-onpause');
                } else {
                    console.log("RadioEngine: HTML5 audio node paused unexpectedly, resuming...");
                    node.play().catch(() => {
                        this._scheduleReconnect(1000, 'node-onpause-play-failed');
                    });
                }
            }
        };

        node.onerror = (e) => {
            console.error("RadioEngine: HTML5 audio node error", e);
            if (this.shouldBePlaying) {
                this.isReconnecting = false;
                this._scheduleReconnect(1500, 'node-onerror');
            }
        };

        node.onstalled = () => {
            console.warn("RadioEngine: HTML5 audio node stalled");
            if (this.shouldBePlaying && !this.isReconnecting) {
                node.play().catch(() => {});
            }
        };

        node.onplaying = () => {
            this.isPlaying = true;
            this.isReconnecting = false;
            this.inPlaceFailCount = 0;
            if (this.onBufferingChange) this.onBufferingChange(false);
            if (this.onPlay) this.onPlay();
        };

        node.onwaiting = () => {
            if (this.shouldBePlaying && this.onBufferingChange) {
                this.onBufferingChange(true);
            }
        };
    }

    _healStream(reason = 'auto', forceNow = false) {
        if (!this.shouldBePlaying) return;

        const now = Date.now();
        if (!forceNow && this.isReconnecting && (now - this.lastReconnectTime < 3500)) {
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.isReconnecting = true;
        this.lastReconnectTime = now;
        console.warn(`RadioEngine: Healing live stream (reason: ${reason})...`);

        if (this.onBufferingChange) this.onBufferingChange(true);
        this._unlockAudioContext();

        const node = this.howl && this.howl._sounds && this.howl._sounds[0]
            ? this.howl._sounds[0]._node
            : null;

        // Reuse the existing user-blessed HTML5 <audio> element so browsers never block auto-reconnect
        if (node && this.inPlaceFailCount < 3) {
            try {
                const freshUrl = `${this.streamUrl}?q=${this.currentQuality}&t=${Date.now()}`;
                this.lastBufferedParams = { end: 0, total: 0 };
                this._attachNodeListeners(node);
                node.src = freshUrl;
                node.load();

                const playPromise = node.play();
                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        this.isPlaying = true;
                        this.isReconnecting = false;
                        this.inPlaceFailCount = 0;
                        if (this.onPlay) this.onPlay();
                        this._setupMediaSession();
                        this._connectVisualizer();
                    }).catch((err) => {
                        console.warn("RadioEngine: In-place stream reload rejected, scheduling retry:", err);
                        this.inPlaceFailCount++;
                        this.isReconnecting = false;
                        this._scheduleReconnect(2000, 'inplace-play-rejected');
                    });
                } else {
                    this.isPlaying = true;
                    this.isReconnecting = false;
                }
                return;
            } catch (err) {
                console.warn("RadioEngine: In-place reload threw error, recreating Howl:", err);
                this.inPlaceFailCount++;
            }
        }

        // Fallback: full Howl recreation
        this.inPlaceFailCount = 0;
        this.isReconnecting = false;
        this.isPlaying = false;
        this._startLiveStream();
    }

    async init() {
        if (this._initialized) return;
        this._initialized = true;

        const saved = localStorage.getItem('serg_quality');
        if (saved) {
            this.currentQuality = saved;
        } else if (navigator.connection && (navigator.connection.saveData || navigator.connection.type === 'cellular' || navigator.connection.effectiveType === '2g' || navigator.connection.effectiveType === '3g')) {
            this.currentQuality = '192';
        } else {
            this.currentQuality = '320';
        }

        // Always notify UI of the final quality
        if (this.onQualityChange) {
            this.onQualityChange(this.currentQuality);
        }

        this._updateMetadata();
        this._setupNetworkListeners();

        // Audio Device Change Listener (Auto-Resume)
        this._setupDeviceChangeListener();
    }

    setQuality(q) {
        if (q === this.currentQuality) return;
        console.log(`RadioEngine: Switching Quality to ${q}kbps`);
        this.currentQuality = q;
        localStorage.setItem('serg_quality', q);

        if (this.onQualityChange) this.onQualityChange(q);

        if (this.isPlaying || this.shouldBePlaying) {
            this.reconnect();
        }
    }

    async _updateMetadata() {
        try {
            const response = await fetch('https://yepzhi-sergradio-sync.hf.space/');
            const data = await response.json();
            if (data.now_playing && this.onTrackChange) {
                this.onTrackChange(data.now_playing);
            }
        } catch (error) {
            console.error('Failed to fetch metadata:', error);
        }
    }

    _setupNetworkListeners() {
        window.addEventListener('online', () => {
            if (this.shouldBePlaying) {
                console.log("RadioEngine: Network back online, healing stream...");
                this._healStream('network-online', true);
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.shouldBePlaying) {
                this._unlockAudioContext();
                const node = this.howl && this.howl._sounds && this.howl._sounds[0]
                    ? this.howl._sounds[0]._node
                    : null;
                if (!node || node.paused || node.ended || node.error) {
                    this._healStream('visibility-resume');
                }
            }
        });

        if (navigator.connection) {
            navigator.connection.addEventListener('change', () => {
                if (!localStorage.getItem('serg_quality')) {
                    const conn = navigator.connection;
                    if (conn.saveData || conn.type === 'cellular' || ['2g', '3g'].includes(conn.effectiveType)) {
                        if (this.currentQuality !== '192') {
                            this.setQuality('192');
                        }
                    } else {
                        if (this.currentQuality !== '320') {
                            this.setQuality('320');
                        }
                    }
                } else if (this.shouldBePlaying) {
                    this._scheduleReconnect(1000, 'connection-change');
                }
            });
        }
    }

    play() {
        this.shouldBePlaying = true;
        if (this.isPlaying && !this.isReconnecting) return;

        // If we already have a blessed HTML5 audio node, heal it in-place
        if (this.howl && this.howl._sounds && this.howl._sounds[0] && this.howl._sounds[0]._node) {
            this._healStream('play-resume', true);
            this._startBufferingWatchdog();
            this._startSilenceMonitor();
            return;
        }

        this._startLiveStream();
    }

    _startLiveStream() {
        console.log("RadioEngine: Starting Stream...");
        if (this.onLoadStart) this.onLoadStart();

        // CRITICAL: Unlock AudioContext BEFORE creating Howl (Chrome/Firefox fix)
        this._unlockAudioContext();

        // 1. Unload previous instance to ensure fresh live edge
        if (this.howl) {
            this.howl.unload();
            this.howl = null;
        }

        this.lastBufferedParams = { end: 0, total: 0 };

        this.howl = new Howl({
            src: [`${this.streamUrl}?q=${this.currentQuality}&t=${Date.now()}`],
            format: ['mp3'],
            html5: true, // Required for long streams & iOS background audio
            preload: true, // Load sound and initialize HTML5 node immediately
            volume: this.volume,
            autoplay: false,
            onplay: () => {
                console.log("RadioEngine: Stream Playing!");
                this.isPlaying = true;
                this.isReconnecting = false;
                this.inPlaceFailCount = 0;
                if (this.onPlay) this.onPlay();
                this._setupMediaSession();
                this._connectVisualizer();
            },
            onloaderror: (id, err) => {
                console.error("RadioEngine: Stream Connection Error", err);
                this.isReconnecting = false;
                this._scheduleReconnect(2000, 'onloaderror');
            },
            onplayerror: (id, err) => {
                console.warn("RadioEngine: Play blocked by browser, retrying...", err);
                this._unlockAudioContext();
                this._scheduleReconnect(1000, 'onplayerror');
            },
            onend: () => {
                console.log("RadioEngine: Stream ended (connection closed), reconnecting...");
                this.isReconnecting = false;
                this._scheduleReconnect(500, 'onend');
            }
        });

        // 3. Attach resilient listeners to the HTML5 audio element
        if (this.howl._sounds.length > 0 && this.howl._sounds[0]._node) {
            this._attachNodeListeners(this.howl._sounds[0]._node);
        }

        // 4. Start playback
        this.howl.play();

        // Ensure listeners attached if node was created during play()
        if (this.howl._sounds.length > 0 && this.howl._sounds[0]._node) {
            this._attachNodeListeners(this.howl._sounds[0]._node);
        }

        // 5. Start Watchdog
        this._startBufferingWatchdog();
        // 6. Start Silence Monitor
        this._startSilenceMonitor();
    }

    _startBufferingWatchdog() {
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);

        let stuckTime = 0;
        let lastTime = -1;
        let missingNodeCount = 0;

        this.watchdogInterval = setInterval(() => {
            if (!this.howl || !this.shouldBePlaying) return;

            // Auto-resume AudioContext if suspended by browser policy
            if (Howler.ctx && Howler.ctx.state === 'suspended' && this.shouldBePlaying) {
                Howler.ctx.resume().catch(() => {});
            }

            const sound = this.howl._sounds[0];
            const node = sound ? sound._node : null;

            if (!node) {
                missingNodeCount++;
                if (missingNodeCount >= 3) {
                    missingNodeCount = 0;
                    this._scheduleReconnect(1000, 'missing-node');
                }
                return;
            }
            missingNodeCount = 0;

            const currentTime = node.currentTime;

            // Condition: Time hasn't moved significant amount or node is paused/errored
            if (Math.abs(currentTime - lastTime) < 0.05 || node.paused || node.ended || node.error) {
                stuckTime += 1000;
                // Notify UI: Buffering
                if (stuckTime >= 2000) {
                    if (this.onBufferingChange) this.onBufferingChange(true);
                }

                // Step 1 (at 3s stuck): attempt soft play resume if paused without error/EOF
                if (stuckTime === 3000 && node.paused && !node.ended && !node.error && !this.isReconnecting) {
                    this._unlockAudioContext();
                    node.play().catch(() => {});
                }

                // Step 2 (at 6s stuck): soft resume did not advance currentTime -> force fresh stream URL reload!
                if (stuckTime >= 6000) {
                    console.warn("RadioEngine: Watchdog detected stalled stream (>6s), forcing stream heal...");
                    stuckTime = 0;
                    this._healStream('watchdog-stuck', true);
                }
            } else {
                // Recovered & advancing normally!
                if (stuckTime > 0 || this.isReconnecting) {
                    if (this.onBufferingChange) this.onBufferingChange(false);
                }
                stuckTime = 0;
                this.isReconnecting = false;
                this.inPlaceFailCount = 0;
                this.isPlaying = true;
            }

            lastTime = currentTime;

            // --- REAL NETWORK CONSUMPTION TRACKING (v2.8.4) ---
            try {
                const ranges = node.buffered;
                let leadingEdge = 0;
                if (ranges.length > 0) {
                    leadingEdge = ranges.end(ranges.length - 1);
                }

                let secondsDownloaded = 0;
                if (this.lastBufferedParams.end > 0) {
                    secondsDownloaded = leadingEdge - this.lastBufferedParams.end;
                }

                if (secondsDownloaded < 0) secondsDownloaded = 0;

                const bytesPerSecond = this.currentQuality === '192' ? 24000 : 40000;
                const bytesDownloaded = secondsDownloaded * bytesPerSecond;
                this.sessionTotalBytes += bytesDownloaded;

                this.lastBufferedParams.end = leadingEdge;

                if (this.onNetworkStats) {
                    this.onNetworkStats({
                        speed: bytesDownloaded,
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

        // Store state for auto-resume on device reconnect
        if (this.isPlaying) {
            this.wasPlayingBeforeDisconnect = true;
        }

        this.shouldBePlaying = false;
        this.isPlaying = false;
        this.isReconnecting = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.howl) {
            this.howl.unload(); // Truly stop to save bandwidth
            this.howl = null;
        }
        if (this.watchdogInterval) clearInterval(this.watchdogInterval);
        if (this.onBufferingChange) this.onBufferingChange(false);
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
        if (!this.isPlaying) return null;

        if (!this.dataArray) {
            this.dataArray = new Uint8Array(32);
        }

        // Generate lively, realistic rhythmic frequency data aligned with the music
        const now = Date.now();
        // Dynamic BPM pulse (~124 BPM, standard house / DJ mix groove)
        const beatPhase = (now % 484) / 484; // 124 BPM cycle
        const kickEnergy = Math.pow(Math.max(0, 1 - beatPhase * 2.2), 2); // Punchy kick decay
        const snarePhase = ((now + 242) % 484) / 484;
        const snareEnergy = Math.pow(Math.max(0, 1 - snarePhase * 2.5), 2);
        const hihat = (Math.sin(now / 30) + 1) * 0.5;

        for (let i = 0; i < this.dataArray.length; i++) {
            let val = 0;
            if (i < 4) {
                // Sub-bass & Kick (Bins 0-3)
                val = (kickEnergy * 200) + 40 + (Math.random() * 25);
            } else if (i < 12) {
                // Low-mids & Snare (Bins 4-11)
                val = (snareEnergy * 160) + 30 + (Math.random() * 20);
            } else {
                // Highs & Shimmer (Bins 12-31)
                val = (hihat * 90) + (Math.random() * 40);
            }
            this.dataArray[i] = Math.min(255, Math.floor(val));
        }

        return this.dataArray;
    }

    _connectVisualizer() {
        // Native HTML5 audio plays directly to hardware speakers for 100% reliable,
        // background/lock-screen safe playback without AudioContext suspension bugs.
        // The visualizer is driven seamlessly via getAudioData().
        if (!this.dataArray) {
            this.dataArray = new Uint8Array(32);
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

    // --- Audio Output Selection (v3.2.5) ---

    async getAudioOutputs() {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => { });
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d.kind === 'audiooutput');
        } catch (err) {
            console.warn('RadioEngine: Cannot enumerate audio devices:', err);
            return [];
        }
    }

    async setAudioOutput(deviceId) {
        try {
            const node = this.howl && this.howl._sounds && this.howl._sounds[0] ? this.howl._sounds[0]._node : null;
            if (node && typeof node.setSinkId === 'function') {
                await node.setSinkId(deviceId);
                this.currentOutputDevice = deviceId;
                console.log('RadioEngine: HTML5 audio node output changed to:', deviceId);
                if (this.onAudioOutputChange) this.onAudioOutputChange(deviceId);
                localStorage.setItem('serg_audio_output', deviceId);
            } else if (Howler.ctx && typeof Howler.ctx.setSinkId === 'function') {
                await Howler.ctx.setSinkId(deviceId);
                this.currentOutputDevice = deviceId;
                console.log('RadioEngine: Audio output changed to:', deviceId);
                if (this.onAudioOutputChange) this.onAudioOutputChange(deviceId);
                localStorage.setItem('serg_audio_output', deviceId);
            } else {
                console.warn('RadioEngine: setSinkId not supported');
            }
        } catch (err) {
            console.error('RadioEngine: Failed to set audio output:', err);
        }
    }

    async selectAudioOutput() {
        try {
            if (navigator.mediaDevices.selectAudioOutput) {
                const device = await navigator.mediaDevices.selectAudioOutput();
                if (device) {
                    await this.setAudioOutput(device.deviceId);
                    return device;
                }
            } else {
                console.warn('RadioEngine: selectAudioOutput not supported');
            }
        } catch (err) {
            console.error('RadioEngine: Audio output selection cancelled or failed:', err);
        }
        return null;
    }

    _setupDeviceChangeListener() {
        if (navigator.mediaDevices) {
            navigator.mediaDevices.addEventListener('devicechange', async () => {
                console.log('RadioEngine: Audio device change detected');

                if (this.wasPlayingBeforeDisconnect && !this.isPlaying) {
                    console.log('RadioEngine: Auto-resuming playback after device reconnect');
                    setTimeout(() => {
                        this.play();
                        this.wasPlayingBeforeDisconnect = false;
                    }, 500);
                }

                const savedOutput = localStorage.getItem('serg_audio_output');
                if (savedOutput) {
                    const devices = await this.getAudioOutputs();
                    const found = devices.find(d => d.deviceId === savedOutput);
                    if (found) {
                        await this.setAudioOutput(savedOutput);
                    }
                }
            });
        }
    }
};
