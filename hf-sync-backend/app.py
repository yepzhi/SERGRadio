import os
import time
import threading
import random
import json
from urllib.parse import quote
import subprocess
import requests
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
TRACKS_DIR = "tracks"
os.makedirs(TRACKS_DIR, exist_ok=True)

# Playlist: DJ Mixes (Hosted on Hugging Face Spaces)
PLAYLIST = [
    {"id": "m1", "title": "Doble B Sat 9 Feb Rec 1", "artist": "Serg", "file": "DOBLE B SAT 9 FEB Rec 1 by SERG.mp3"},
    {"id": "m2", "title": "Doble B Sat 9 Feb Rec 2", "artist": "Serg", "file": "DOBLE B SAT 9 FEB Rec 2 by SERG.mp3"},
    {"id": "m3", "title": "Everywhere (Serg Edit)", "artist": "Serg", "file": "EVERYWHERE(SERG EDIT).mp3"},
    {"id": "m4", "title": "Mirrey", "artist": "Serg", "file": "MIRREY by SERG.mp3"},
    {"id": "m5", "title": "Republica De San Pedro", "artist": "Serg", "file": "SERG @REPUBLICA DE SAN PEDRO.mp3"},
    {"id": "m6", "title": "Backroom Hermosillo", "artist": "Serg", "file": "Serg @Backroom HMO.mp3"},
    {"id": "m7", "title": "Serg Minimix v1", "artist": "Serg", "file": "Serg Minimix v1.mp3"},
    {"id": "m8", "title": "Thursdays At The Decks", "artist": "Serg", "file": "Thursdays At The Decks With Serg.mp3"},
    {"id": "m9", "title": "Up In The Club With My Homies", "artist": "Serg", "file": "UP IN THE CLUB WITH MY HOMIES.mp3"},
]

# Global State
CLIENTS = []
# BURST_BUFFER: Pre-fills new clients for instant playback
# Reduced to ~10 seconds (25 chunks) to prevent "Jumping Back" on reconnects
BURST_BUFFER = deque(maxlen=25)
CURRENT_TRACK_INFO = {"title": "Connecting...", "artist": "SERGRadio"}

# Track Queue for pre-downloaded files
# Track Queue for pre-downloaded files
# Increased to 3 to ensure FULL mixes are ready well in advance
READY_TRACKS = Queue(maxsize=3)

# Track Shuffle Bag (Even Distribution)
SHUFFLE_BAG = []
STATE_FILE = "shuffle_state.json"

def select_next_track():
    """Select next track using shuffle bag for even distribution"""
    global SHUFFLE_BAG
    if not SHUFFLE_BAG:
        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, 'r') as f:
                    SHUFFLE_BAG = json.load(f)
                print(f"Loaded Shuffle Bag: {len(SHUFFLE_BAG)} items")
            except:
                pass
        
        if not SHUFFLE_BAG:
            SHUFFLE_BAG = list(PLAYLIST)
            random.shuffle(SHUFFLE_BAG)
            print("Refilled Shuffle Bag")

    if not SHUFFLE_BAG:
        return random.choice(PLAYLIST)

    track = SHUFFLE_BAG.pop()
    
    try:
        with open(STATE_FILE, 'w') as f:
            json.dump(SHUFFLE_BAG, f)
    except:
        pass
    
    return track

def download_track(filename):
    """Download track from HF to local cache"""
    encoded_filename = quote(filename)
    url = f"{BASE_URL}{encoded_filename}"
    local_path = os.path.join(TRACKS_DIR, filename)
    
    # Check cache (file exists and > 1MB)
    if os.path.exists(local_path) and os.path.getsize(local_path) > 1024 * 1024:
        print(f"Cache hit: {filename}")
        return local_path
    
    print(f"Downloading: {filename}...")
    try:
        headers = {}
        token = os.environ.get("HF_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        
        # Stream download with long timeout
        r = requests.get(url, stream=True, timeout=7200, headers=headers)
        if r.status_code == 200:
            with open(local_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=65536):
                    f.write(chunk)
            size_mb = os.path.getsize(local_path) / (1024 * 1024)
            print(f"Downloaded: {filename} ({size_mb:.1f} MB)")
            return local_path
        else:
            print(f"Download failed: {r.status_code}")
    except Exception as e:
        print(f"Download error: {e}")
    return None

def track_manager():
    """Background thread to keep READY_TRACKS queue filled"""
    print("Track Manager started")
    while True:
        try:
            if not READY_TRACKS.full():
                track = select_next_track()
                path = download_track(track['file'])
                if path:
                    READY_TRACKS.put({'track': track, 'path': path})
                    print(f"Queued: {track['title']}")
                else:
                    time.sleep(5)  # Retry delay
            else:
                time.sleep(1)
        except Exception as e:
            print(f"Track Manager error: {e}")
            time.sleep(2)

def broadcast_stream():
    """Main broadcast loop - plays from local files for reliability"""
    global CURRENT_TRACK_INFO
    print("Broadcast started (Local File Mode)")
    
    # Larger chunks for smoother continuous playback (64KB)
    CHUNK_SIZE = 65536
    
    while True:
        try:
            # Wait for next ready track
            print("Waiting for next track...")
            item = READY_TRACKS.get()
            track = item['track']
            local_path = item['path']
            
            # Verify file exists and is valid
            if not os.path.exists(local_path):
                print(f"File missing: {local_path}")
                continue
                
            file_size = os.path.getsize(local_path)
            # Lowered check to 3MB (User has some 10MB mixes)
            if file_size < 3 * 1024 * 1024: 
                print(f"File too small ({file_size} bytes), skipping: {local_path}")
                os.remove(local_path)  # Remove corrupt file
                continue
            
            # DELAYED METADATA UPDATE
            # The server buffers ~20s of audio before it reaches the client.
            def update_meta_delayed():
                 global CURRENT_TRACK_INFO
                 
                 # Calculate Duration (320kbps = 40,000 bytes/sec)
                 duration_sec = file_size / 40000
                 
                 # Add duration and start time to track info
                 track['duration'] = duration_sec
                 track['started_at'] = time.time()
                 
                 CURRENT_TRACK_INFO = track
                 print(f"METADATA UPDATED: {track['title']} (Duration: {duration_sec/60:.1f}m)")
            
            # 20 second delay to match buffer latency
            threading.Timer(20.0, update_meta_delayed).start()
            
            print(f"STREAMING START: {track['title']} ({file_size / (1024*1024):.1f} MB)")
            
            # FFmpeg command for local file playback
            cmd = [
                'ffmpeg',
                '-re',  # Real-time playback
                '-i', local_path,
                '-vn',
                '-f', 'mp3',
                '-b:a', '320k',
                '-bufsize', '8192k',  # Large buffer for smooth output
                '-ac', '2',
                '-ar', '44100',
                '-loglevel', 'error',
                'pipe:1'
            ]
            
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            bytes_streamed = 0
            start_time = time.time()
            
            while True:
                chunk = process.stdout.read(CHUNK_SIZE)
                if not chunk:
                    stderr = process.stderr.read()
                    if stderr:
                        print(f"FFmpeg: {stderr.decode()[:200]}")
                    break
                
                bytes_streamed += len(chunk)
                BURST_BUFFER.append(chunk)
                
                dead_clients = []
                for q in CLIENTS:
                    try:
                        if q.full():
                            try:
                                q.get_nowait()
                            except Empty:
                                pass
                        q.put_nowait(chunk)
                    except:
                        dead_clients.append(q)
                
                for q in dead_clients:
                    if q in CLIENTS:
                        CLIENTS.remove(q)
            
            process.wait()
            
            duration = time.time() - start_time
            print(f"FINISHED: {track['title']} - {bytes_streamed/(1024*1024):.1f}MB in {duration/60:.1f} min")
            
        except Exception as e:
            print(f"Broadcast error: {e}")
            time.sleep(2)

# Start Background Threads
threading.Thread(target=track_manager, daemon=True).start()
threading.Thread(target=broadcast_stream, daemon=True).start()

@app.get("/")
def index():
    now_playing = {
        "title": CURRENT_TRACK_INFO.get("title", "Unknown"),
        "artist": CURRENT_TRACK_INFO.get("artist", "SERGRadio"),
        "duration": CURRENT_TRACK_INFO.get("duration", 0),
        "started_at": CURRENT_TRACK_INFO.get("started_at", 0)
    }
    return {
        "status": "radio_active",
        "version": "2.8.6",
        "mode": "local_file_streaming",
        "quality": "320kbps CBR",
        "listeners": len(CLIENTS),
        "queue_size": READY_TRACKS.qsize(),
        "now_playing": now_playing
    }

@app.get("/stream")
def stream_audio():
    def event_stream():
        # Large queue for maximum stability (~6-7 min buffer)
        q = Queue(maxsize=1000)
        
        # Burst-fill with recent audio
        backlog = list(BURST_BUFFER)
        for chunk in backlog:
            try:
                q.put_nowait(chunk)
            except Full:
                break
        
        CLIENTS.append(q)
        print(f"Client connected. Burst: {len(backlog)}. Listeners: {len(CLIENTS)}")
        
        try:
            while True:
                chunk = q.get()
                yield chunk
        except Exception as e:
            print(f"Client disconnected: {e}")
        finally:
            if q in CLIENTS:
                CLIENTS.remove(q)

    headers = {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Internal-Topic": "radio-stream",
        "Connection": "keep-alive",
        "Content-Type": "audio/mpeg",
        "ice-name": "SERGRadio",
        "ice-description": "Live DJ Mixes",
        "ice-audio-info": "bitrate=320",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
        "X-Content-Type-Options": "nosniff"
    }
    
    return StreamingResponse(event_stream(), media_type="audio/mpeg", headers=headers)
