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
            autoplay: true,
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

                        // --- EQ Restoration & "PowerHitz" Processing ---

                        // 1. Dynamics Compressor (Radio Limiter / Glue)
                        const compressor = ctx.createDynamicsCompressor();
                        compressor.threshold.value = -14; // Compress slightly more for consistency
                        compressor.knee.value = 12;       // Slightly harder knee
                        compressor.ratio.value = 6;       // 6:1 Radio Ratio
                        compressor.attack.value = 0.003;  // Faster attack
                        compressor.release.value = 0.15;

                        // 2. EQ Filters (V-Shape / Extreme Clarity)
                        // Low Shelf (Deep Bass + Punch)
                        const lowShelf = ctx.createBiquadFilter();
                        lowShelf.type = 'lowshelf';
                        lowShelf.frequency.value = 85; // Focused on kick/sub
                        lowShelf.gain.value = 8.0;     // +8dB (Punchier)

                        // Mid (Scoop - Remove Mud)
                        const mid = ctx.createBiquadFilter();
                        mid.type = 'peaking';
                        mid.frequency.value = 1000;
                        mid.gain.value = -6.0; // Deeper scoop for clarity
                        mid.Q.value = 1.2;

                        // High Shelf (Crystal Clarity / Air)
                        const highShelf = ctx.createBiquadFilter();
                        highShelf.type = 'highshelf';
                        highShelf.frequency.value = 5500;
                        highShelf.gain.value = 10.0; // +10dB (Crisp treble)

                        // Master Gain (Headroom for Boosts)
                        const masterGain = ctx.createGain();
                        masterGain.gain.value = 0.55; // Slightly lower to compensate for higher shelving gains

                        // Connect Graph: 
                        // Source -> Low -> Mid -> High -> Compressor -> Master -> Analyser -> Destination
                        source.connect(lowShelf);
                        lowShelf.connect(mid);
                        mid.connect(highShelf);
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
