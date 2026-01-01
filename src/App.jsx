import { useState, useEffect, useRef } from 'react';
import { radio } from './audio/RadioEngine';
import { WifiOff, Play, Pause, User, RefreshCw, Activity } from 'lucide-react';
import AdSpace from './components/AdSpace';
import './App.css';

function App() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [track, setTrack] = useState(null);
  const [isLive, setIsLive] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isReady, setIsReady] = useState(false); // Radio ready state

  // PWA State removed

  // Visualizer Ref
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const particles = useRef([]);

  // Listeners Count State
  const [listeners, setListeners] = useState(0);

  // Poll for listener count
  useEffect(() => {
    const fetchListeners = async () => {
      try {
        const res = await fetch('https://yepzhi-sergradio-sync.hf.space/');
        if (res.ok) {
          const data = await res.json();
          setListeners(data.listeners || 0);
          // Auto-update track info from server (Metadata Sync)
          if (data.now_playing) {
            setTrack(data.now_playing);
          }
        }
      } catch (e) {
        // Silent fail
      }
    };

    fetchListeners();
    const interval = setInterval(fetchListeners, 5000); // Poll every 5s for faster metadata updates
    return () => clearInterval(interval);
  }, []);

  // Update Media Session Metadata
  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track ? track.title : "SERGRadio Live",
        artist: track ? track.artist : `${listeners} listeners`,
        artwork: [{ src: 'https://yepzhi.com/SERGRadio/logo.svg', sizes: '512x512', type: 'image/svg+xml' }]
      });
    }
  }, [listeners, track]);


  useEffect(() => {
    // Network Status
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // PWA Install Prompt - Removed

    // Initialize Audio Engine (async)
    const initRadio = async () => {
      // Failsafe: Force entry after 5 seconds no matter what
      const failsafeTimer = setTimeout(() => {
        console.warn("RadioEngine init timed out, forcing start");
        setIsReady(true);
      }, 5000);

      try {
        await radio.init();
      } catch (err) {
        console.error("RadioEngine init failed:", err);
      }

      clearTimeout(failsafeTimer);
      setIsReady(true);
    };
    initRadio();

    // Local override removed to rely on server poll
    // radio.onTrackChange = (newTrack) => {
    //   setTrack(newTrack);
    // };

    // Buffering Events
    radio.onLoadStart = () => {
      setIsBuffering(true);
      setIsLive(false);
    };

    radio.onPlay = () => {
      setIsBuffering(false);
      setIsLive(true);
    };

    // Watchdog Buffering Hook
    radio.onBufferingChange = (state) => {
      setIsBuffering(state);
    };

    // Initialize Particles Logic
    const initParticles = (width, height) => {
      const count = 60;
      const newParticles = [];
      for (let i = 0; i < count; i++) {
        newParticles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          baseRadius: Math.random() * 2 + 0.5,
          speedX: (Math.random() - 0.5) * 0.5,
          speedY: (Math.random() - 0.5) * 0.5,
          phase: Math.random() * Math.PI * 2
        });
      }
      particles.current = newParticles;
    };


    // Audio Visualizer Animation Loop
    const renderVisualizer = () => {
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      // Init particles on first run or resize
      if (particles.current.length === 0) {
        initParticles(width, height);
      }

      // Get Data
      const data = radio.getAudioData();

      // Calculate Bass Energy (reaction factor)
      let bassEnergy = 0;
      if (data) {
        // Sum first 10 bins (low freq)
        for (let i = 0; i < 10; i++) bassEnergy += data[i];
        bassEnergy /= 10; // Average 0-255
        bassEnergy /= 255; // Normalize 0-1
      }

      // Idle movement if no audio
      const reaction = isPlaying && !isBuffering ? bassEnergy : 0.05;

      ctx.clearRect(0, 0, width, height);

      // Draw Particles
      particles.current.forEach(p => {
        // Update Position
        p.x += p.speedX;
        p.y += p.speedY;

        // Wrap around
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        // React to Audio
        // Size pulses with bass
        const boost = reaction * 3;
        const radius = p.baseRadius + boost;

        // Color based on intensity
        // Idle: White/Gold faint. Active: Red/Gold bright.
        const alpha = 0.3 + reaction * 0.7;

        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`; // White stars (for blue theme)
        ctx.shadowBlur = reaction * 10;
        ctx.shadowColor = '#3b82f6'; // Blue glow
        ctx.fill();

        // Draw connections for "Antigravity" web effect
        // Only connect nearby particles if loud enough
        if (reaction > 0.2) {
          particles.current.forEach(p2 => {
            const dx = p.x - p2.x;
            const dy = p.y - p2.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 50) {
              ctx.beginPath();
              ctx.moveTo(p.x, p.y);
              ctx.lineTo(p2.x, p2.y);
              ctx.strokeStyle = `rgba(59, 130, 246, ${0.1 + reaction * 0.2})`; // faint blue lines
              ctx.lineWidth = 0.5;
              ctx.stroke();
            }
          });
        }
      });

      animationRef.current = requestAnimationFrame(renderVisualizer);
    };

    renderVisualizer();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying]);

  const togglePlay = () => {
    // Resume Audio Context (Browser Policy)
    radio.resumeContext();

    if (isPlaying) {
      radio.pause();
    } else {
      radio.play();
    }
    setIsPlaying(!isPlaying);
  };




  return (
    <div className="container min-h-[100dvh] flex flex-col items-center justify-center p-4 md:p-5 pb-16 md:pb-20 relative z-10 w-full max-w-4xl mx-auto">

      {/* Loading Screen - Waking Radio */}
      {!isReady && (
        <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50">
          <h1 className="logo-text text-5xl font-black tracking-tighter mb-4 text-white">SERGRadio</h1>
          <div className="text-blue-500 animate-pulse text-lg mb-4">Waking up the radio...</div>
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-8"></div>

          {/* Failsafe Button - shows after 3s */}
          <button
            onClick={() => setIsReady(true)}
            className="text-gray-500 text-xs hover:text-white underline animate-in fade-in duration-1000 delay-3000 opacity-0 fill-mode-forwards"
            style={{ animationDelay: '3s', animationFillMode: 'forwards' }}
          >
            Taking too long? Start anyway
          </button>
        </div>
      )}

      {/* Network Warning */}
      {!isOnline && (
        <div className="fixed top-0 left-0 w-full bg-blue-900/90 text-white z-50 text-center py-2 text-sm font-bold flex items-center justify-center gap-2 backdrop-blur-md">
          <WifiOff size={16} />
          <span>Connection Lost</span>
        </div>
      )}

      {/* Logo Section */}
      <div className="text-center mb-6 relative">
        <h1 className="logo-base text-6xl md:text-8xl font-black tracking-tighter mb-0">
          <span className="text-blue-700 tracking-tighter serg-blue-text">SERG</span><span className="radio-gradient-text">Radio</span>
        </h1>
        <div className="text-right pr-2 md:pr-4 -mt-1">
          <span className="text-gray-500 font-bold text-xs md:text-sm tracking-wide lowercase">by </span>
          <a href="https://www.instagram.com/sergrdz?utm_source=ig_web_button_share_sheet&igsh=ZDNlZDc0MzIxNw==" target="_blank" rel="noreferrer" className="text-blue-500 font-black text-xs md:text-sm hover:text-white transition-all uppercase">@SERG</a>
        </div>
      </div>

      {/* Live Status & Listeners - REMOVED (Moved below) */}

      {/* Player Card (Glass - Extra Foggy) */}
      <div className="glass-panel backdrop-blur-3xl rounded-[30px] p-6 md:p-8 lg:p-10 w-full md:w-auto min-w-[300px] md:min-w-[450px] flex flex-col items-center gap-4 md:gap-5 mb-1 transition-all duration-500 relative overflow-hidden">

        {/* Real-Time Visualizer (Canvas Background) */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 pointer-events-none opacity-60 z-0 h-32">
          <canvas ref={canvasRef} width={450} height={150} className="w-full h-full object-contain"></canvas>
        </div>


        {/* Top LEFT Status (v2.6.2) */}
        {(isPlaying || isBuffering) && <div className="absolute top-6 left-6 z-20 flex items-center space-x-2 animate-in fade-in duration-500">
          <div className={`flex items-center space-x-2 px-3 py-1.5 rounded-full bg-black/60 border border-white/10 shadow-lg backdrop-blur-md transition-all duration-300 ${isBuffering ? 'animate-pulse border-emerald-500/50' : ''}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${isBuffering ? 'bg-yellow-500' : (!isOnline ? 'bg-red-500' : 'bg-emerald-400')}`}></div>
            <span className={`text-[9px] uppercase tracking-widest font-bold ${isBuffering ? 'text-yellow-500' : (!isOnline ? 'text-red-500' : 'text-emerald-400')}`}>
              {isBuffering ? 'Reconnecting...' : (!isOnline ? 'Unstable' : 'Stable')}
            </span>
          </div>
        </div>
        }

        {/* Bottom LEFT Refresh Button (v2.6.2) */}
        {(isPlaying || isBuffering) && (
          <button
            onClick={() => radio.reconnect()}
            className="absolute bottom-6 left-6 z-20 p-2 rounded-full bg-black/40 hover:bg-black/80 text-gray-500 hover:text-white transition-all active:scale-90 border border-white/5 hover:border-white/20 shadow-lg backdrop-blur-md"
            title="Force Refresh Connection">
            <RefreshCw size={14} />
          </button>
        )}

        {/* Top Right Status & Logo */}
        <div className="absolute top-6 right-6 z-20 flex flex-col items-end gap-1">
          <div className={`text-xs uppercase tracking-[2px] font-bold flex items-center gap-2 leading-none ${isLive ? 'text-blue-500' : 'text-gray-500'}`}>
            {isPlaying && isLive && <span className="w-2 h-2 rounded-full bg-blue-600 live-dot-anim relative top-[0.5px]"></span>}
            {isPlaying ? (isBuffering ? 'BUFFERING...' : 'LIVE') : ''}
          </div>
          {/* HD Radio Logo - Top Right */}
          <img src="/SERGRadio/hd-logo.png" alt="HD Radio" className="h-5 opacity-90 mt-1" />
        </div>

        {/* Play Button */}
        <button
          onClick={togglePlay}
          className={`play-btn-glow w-28 h-28 md:w-32 md:h-32 rounded-full flex items-center justify-center text-blue-500 hover:text-white transition-colors cursor-pointer relative group mt-4 z-10 ${isBuffering ? 'animate-pulse' : ''}`}
        >
          {/* Spinner Ring if buffering */}
          {isBuffering && isPlaying ? (
            <div className="absolute inset-0 border-4 border-blue-500/30 border-t-blue-500 rounded-full animate-spin"></div>
          ) : null}
          <div className="relative z-10">
            {isPlaying ? (
              isBuffering ? null : <Pause size={48} fill="currentColor" />
            ) : (
              <Play size={48} fill="currentColor" className="ml-2" />
            )}
          </div>
        </button>

        {/* Now Playing Info */}
        <div className="text-center min-h-[60px] flex flex-col items-center justify-center z-10">
          {!isPlaying && (
            <div className="text-sm uppercase tracking-[2px] mb-2 font-medium text-gray-500">
              CLICK TO START
            </div>
          )}

          <div className={`transition - all duration - 500 ${isPlaying ? 'opacity-100 transform translate-y-0' : 'opacity-0 transform translate-y-2'} `}>
            {/* Track Title */}
            {track && track.title && (
              <h2 className="text-base md:text-xl font-bold text-white mb-1 drop-shadow-md max-w-[280px] md:max-w-[400px] text-center leading-tight">
                {track.title}
              </h2>
            )}
            <p className="text-gray-400 font-light text-lg mb-1 pt-1">
              Streaming Live 24/7
            </p>
            <p className="text-gray-600 text-[10px] tracking-wider font-medium">
              Non-Stop Music, No Ads.
            </p>
          </div>

        </div>
      </div>

      {/* Listeners Info (Bottom Right of Player) */}
      <div className="w-full md:w-auto min-w-[300px] md:min-w-[450px] flex justify-end px-4 mb-2 md:mb-3">
        <div className="text-gray-500 text-[10px] uppercase tracking-wider font-bold flex items-center space-x-1">
          <User size={10} />
          <span>{listeners} Listening</span>
        </div>
      </div>


      {/* AdSpace */}
      <div className="w-full flex justify-center mb-2 md:mb-4">
        <AdSpace />
      </div>

      {/* Cross Link: hopRadio */}
      <div className="w-full flex justify-center mb-4 pointer-events-auto z-30">
        <a href="https://yepzhi.com/hopRadio/" className="group relative px-6 py-2.5 bg-black/40 backdrop-blur-xl border border-red-900/50 rounded-full flex items-center gap-3 hover:bg-black/80 transition-all hover:scale-105 hover:shadow-[0_0_25px_rgba(255,0,0,0.3)]">
          <span className="text-xs text-gray-400 uppercase tracking-widest font-semibold group-hover:text-gray-300">Listen</span>
          <span className="text-xl font-black tracking-tight"><span className="text-[#fbbf24] drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]">hop</span><span className="text-red-500 drop-shadow-[0_0_8px_rgba(255,0,0,0.8)]">Radio</span></span>
          <svg className="w-5 h-5 text-gray-400 group-hover:text-white transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 8l4 4m0 0l-4 4m4-4H3"></path></svg>
        </a>
      </div>



      {/* Footer (Right Aligned, Stacked Version) */}
      <div className="absolute bottom-4 right-6 z-20 pointer-events-none flex flex-col items-end gap-1">
        <div className="pointer-events-auto flex items-center gap-2">
          <span className="text-gray-500 text-[10px] tracking-wide font-medium mr-1">Mixes by</span>
          <a href="https://www.instagram.com/sergrdz?utm_source=ig_web_button_share_sheet&igsh=ZDNlZDc0MzIxNw==" target="_blank" rel="noreferrer" className="px-3 py-1 rounded-full bg-gradient-to-br from-gray-900 to-black border border-gray-800 text-blue-500 hover:text-blue-400 hover:border-blue-900 transition-all font-bold shadow-sm text-[10px]">
            @SERG
          </a>
          <span className="text-gray-700 mx-1">•</span>
          <span className="text-gray-500 text-[10px] tracking-wide font-medium mr-1">Site by</span>
          <a href="https://yepzhi.com" target="_blank" rel="noreferrer" className="px-3 py-1 rounded-full bg-gradient-to-br from-gray-900 to-black border border-gray-800 text-blue-500 hover:text-blue-400 hover:border-blue-900 transition-all font-bold shadow-sm text-[10px]">
            @yepzhi
          </a>
        </div>
        <div className="text-gray-600 text-[9px] font-mono tracking-widest opacity-80">
          v2.7.1
        </div>

      </div>


    </div>
  );
}

export default App;
