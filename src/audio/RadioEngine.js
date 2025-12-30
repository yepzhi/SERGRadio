import { Howl, Howler } from 'howler';

export const radio = new class RadioEngine {
    constructor() {
        this.streamUrl = 'https://yepzhi-sergradio-sync.hf.space/stream';
        this.howl = null;
        this.isPlaying = false;
        this.volume = 0.6;

        // Hooks
        this.onPlay = null;
        this.onLoadStart = null;
        this.onTrackChange = null;

        // Audio Graph
        this.context = null;
        this.analyser = null;
        this.dataArray = null;
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
            src: [this.streamUrl],
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
        this.howl.play();
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

                        // === ADVANCED AUDIO PROCESSING CHAIN ===
                        // Goal: heavy bass, scooped mids, big high end, energetic transient punch

                        // --- A. FILTERS / EQ ---

                        // 1. High Pass Filter (remove sub-rumble)
                        const hpFilter = ctx.createBiquadFilter();
                        hpFilter.type = 'highpass';
                        hpFilter.frequency.value = 28;
                        hpFilter.Q.value = 0.7;

                        // 2. Low Shelf (body)
                        const lowShelf = ctx.createBiquadFilter();
                        lowShelf.type = 'lowshelf';
                        lowShelf.frequency.value = 95;
                        lowShelf.gain.value = 7.0;  // +7 dB bass

                        // 3. Bass Peak (sub-kick weight)
                        const bassPeak = ctx.createBiquadFilter();
                        bassPeak.type = 'peaking';
                        bassPeak.frequency.value = 60;
                        bassPeak.gain.value = 3.5;  // +3.5 dB peak
                        bassPeak.Q.value = 1.0;

                        // 4. Mid Scoop (clarity)
                        const mid = ctx.createBiquadFilter();
                        mid.type = 'peaking';
                        mid.frequency.value = 800;
                        mid.gain.value = -6.0;  // -6 dB scoop
                        mid.Q.value = 1.0;

                        // 5. Upper-Mid Presence (percussion clarity)
                        const upperMid = ctx.createBiquadFilter();
                        upperMid.type = 'peaking';
                        upperMid.frequency.value = 2500;
                        upperMid.gain.value = 1.5;  // +1.5 dB
                        upperMid.Q.value = 1.2;

                        // 6. High Shelf (air & treble)
                        const highShelf = ctx.createBiquadFilter();
                        highShelf.type = 'highshelf';
                        highShelf.frequency.value = 10000;
                        highShelf.gain.value = 9.0;  // +9 dB treble

                        // --- B. BUS COMPRESSOR (Glue for punch) ---
                        const compressor = ctx.createDynamicsCompressor();
                        compressor.threshold.value = -14;  // ~2-6 dB GR on peaks
                        compressor.knee.value = 6;
                        compressor.ratio.value = 3.0;      // Gentler squeeze (was 3.8)
                        compressor.attack.value = 0.008;   // 8ms
                        compressor.release.value = 0.25;   // 250ms (smoother, less pumping)

                        // --- MASTER GAIN ---
                        const masterGain = ctx.createGain();
                        masterGain.gain.value = 0.93;  // 93% volume

                        // --- CONNECT GRAPH ---
                        // Source -> HPF -> LowShelf -> BassPeak -> Mid -> UpperMid -> HighShelf -> Compressor -> Master -> Analyser -> Out
                        source.connect(hpFilter);
                        hpFilter.connect(lowShelf);
                        lowShelf.connect(bassPeak);
                        bassPeak.connect(mid);
                        mid.connect(upperMid);
                        upperMid.connect(highShelf);
                        highShelf.connect(compressor);
                        compressor.connect(masterGain);
                        masterGain.connect(this.analyser);
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
