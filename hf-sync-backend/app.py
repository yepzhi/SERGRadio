import os
import time
import threading
import random
import json
from urllib.parse import quote
import subprocess
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from queue import Queue, Full, Empty
from collections import deque

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
BASE_URL = "https://huggingface.co/spaces/yepzhi/sergradio-sync/resolve/main/tracks/"

# Playlist: DJ Mixes (Hosted on Hugging Face Spaces)
PLAYLIST = [
    {"id": "m1", "title": "Doble B Sat 9 Feb Rec 1", "artist": "Serg", "file": "DOBLE B SAT 9 FEB Rec 1 by SERG.mp3", "weight": 1},
    {"id": "m2", "title": "Doble B Sat 9 Feb Rec 2", "artist": "Serg", "file": "DOBLE B SAT 9 FEB Rec 2 by SERG.mp3", "weight": 1},
    {"id": "m3", "title": "Everywhere (Serg Edit)", "artist": "Serg", "file": "EVERYWHERE(SERG EDIT).mp3", "weight": 1},
    {"id": "m4", "title": "Mirrey", "artist": "Serg", "file": "MIRREY by SERG.mp3", "weight": 1},
    {"id": "m5", "title": "Republica De San Pedro", "artist": "Serg", "file": "SERG @REPUBLICA DE SAN PEDRO.mp3", "weight": 1},
    {"id": "m6", "title": "Backroom Hermosillo", "artist": "Serg", "file": "Serg @Backroom HMO.mp3", "weight": 1},
    {"id": "m7", "title": "Serg Minimix v1", "artist": "Serg", "file": "Serg Minimix v1.mp3", "weight": 1},
    {"id": "m8", "title": "Thursdays At The Decks", "artist": "Serg", "file": "Thursdays At The Decks With Serg.mp3", "weight": 1},
    {"id": "m9", "title": "Up In The Club With My Homies", "artist": "Serg", "file": "UP IN THE CLUB WITH MY HOMIES.mp3", "weight": 1},
]

# Global State
CLIENTS = []
BURST_BUFFER = deque(maxlen=100)  # ~40 seconds of audio for burst-on-connect
CURRENT_TRACK_INFO = {"title": "Connecting...", "artist": "SERGRadio"}

# Track Shuffle Bag (Even Distribution)
SHUFFLE_BAG = []
STATE_FILE = "shuffle_state.json"

def select_next_track():
    """Select next track using shuffle bag for even distribution"""
    global SHUFFLE_BAG
    if not SHUFFLE_BAG:
        # Try Load State
        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, 'r') as f:
                    SHUFFLE_BAG = json.load(f)
                print(f"Loaded Shuffle Bag from state: {len(SHUFFLE_BAG)} items")
            except Exception as e:
                print(f"Failed to load shuffle state: {e}")
        
        # If still empty, refill
        if not SHUFFLE_BAG:
            SHUFFLE_BAG = list(PLAYLIST)
            random.shuffle(SHUFFLE_BAG)
            print("Refilled Shuffle Bag (Fresh)")

    # Pop track
    if not SHUFFLE_BAG:
        return random.choice(PLAYLIST)

    track = SHUFFLE_BAG.pop()
    
    # Save State
    try:
        with open(STATE_FILE, 'w') as f:
            json.dump(SHUFFLE_BAG, f)
    except Exception as e:
        print(f"Failed to save shuffle state: {e}")
    
    return track

def get_track_url(track):
    """Build full URL for track with proper encoding"""
    encoded_filename = quote(track['file'])
    return f"{BASE_URL}{encoded_filename}"

# Broadcast Thread - Direct HTTP Streaming via FFmpeg
def broadcast_stream():
    """
    Stream audio directly from HF URLs via FFmpeg.
    No pre-download required - FFmpeg fetches chunks as needed.
    Perfect for 3-hour mixes!
    """
    global CURRENT_TRACK_INFO
    print("Starting Direct HTTP Streaming Broadcast...")
    
    CHUNK_SIZE = 16384  # 16KB chunks
    
    # Get HF Token for authenticated requests
    hf_token = os.environ.get("HF_TOKEN", "")
    
    while True:
        try:
            # Select next track
            track = select_next_track()
            track_url = get_track_url(track)
            
            print(f"Now Playing: {track['title']}")
            print(f"Streaming from: {track_url}")
            CURRENT_TRACK_INFO = track
            
            # FFmpeg Command with HTTP input
            # -headers: Add Authorization for HF access
            # -re: Real-time playback speed
            # -reconnect: Auto-reconnect on network issues
            cmd = [
                'ffmpeg',
                '-reconnect', '1',
                '-reconnect_streamed', '1', 
                '-reconnect_delay_max', '5',
            ]
            
            # Add auth header if token available
            if hf_token:
                cmd.extend(['-headers', f'Authorization: Bearer {hf_token}\r\n'])
            
            cmd.extend([
                '-i', track_url,
                '-vn',  # No video
                '-af', 'silenceremove=stop_periods=-1:stop_duration=2:stop_threshold=-50dB',
                '-f', 'mp3',
                '-b:a', '320k',
                '-bufsize', '1024k',
                '-ac', '2',
                '-ar', '44100',
                '-loglevel', 'warning',
                'pipe:1'
            ])
            
            # Start FFmpeg process
            process = subprocess.Popen(
                cmd, 
                stdout=subprocess.PIPE, 
                stderr=subprocess.PIPE
            )
            
            # Stream chunks to clients
            while True:
                chunk = process.stdout.read(CHUNK_SIZE)
                if not chunk:
                    # Check for errors
                    stderr = process.stderr.read()
                    if stderr:
                        print(f"FFmpeg stderr: {stderr.decode()[:500]}")
                    break
                
                # Update Burst Buffer (for new client quick-start)
                BURST_BUFFER.append(chunk)

                # Broadcast to all connected clients
                dead_clients = []
                for q in CLIENTS:
                    try:
                        if q.full():
                            try:
                                q.get_nowait()  # Drop oldest chunk
                            except Empty:
                                pass
                        q.put_nowait(chunk)
                    except Exception:
                        dead_clients.append(q)
                
                # Cleanup disconnected clients
                for q in dead_clients:
                    if q in CLIENTS:
                        CLIENTS.remove(q)
            
            process.wait()
            print(f"Track finished: {track['title']}")
            
        except Exception as e:
            print(f"Streaming error: {e}")
            time.sleep(2)

# Start Broadcast Thread
threading.Thread(target=broadcast_stream, daemon=True).start()

@app.get("/")
def index():
    return {
        "status": "radio_active", 
        "version": "2.7.0",
        "mode": "direct_http_streaming",
        "quality": "320kbps CBR",
        "listeners": len(CLIENTS),
        "now_playing": CURRENT_TRACK_INFO
    }

@app.get("/stream")
def stream_audio():
    def event_stream():
        # Large queue to absorb network jitters
        q = Queue(maxsize=500) 
        
        # BURST: Pre-fill with recent audio for instant playback
        backlog = list(BURST_BUFFER)
        for chunk in backlog:
            try:
                q.put_nowait(chunk)
            except Full:
                break
                
        CLIENTS.append(q)
        print(f"Client connected. Burst: {len(backlog)} chunks. Total listeners: {len(CLIENTS)}")
        
        try:
            while True:
                chunk = q.get()
                yield chunk
        except Exception as e:
            print(f"Client disconnected: {e}")
        finally:
            if q in CLIENTS:
                CLIENTS.remove(q)

    # Headers to prevent caching and enable streaming
    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
        "X-Content-Type-Options": "nosniff"
    }
    
    return StreamingResponse(event_stream(), media_type="audio/mpeg", headers=headers)
