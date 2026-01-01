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

def validate_playlist():
    """Filter playlist to only include tracks that actually exist on the server"""
    print("Validating Playlist Consistency...")
    valid_playlist = []
    
    # Use a session for connection pooling
    session = requests.Session()
    token = os.environ.get("HF_TOKEN")
    if token:
        session.headers.update({"Authorization": f"Bearer {token}"})

    for track in PLAYLIST:
        try:
            filename = quote(track['file'])
            url = f"{BASE_URL}{filename}"
            # Head request to check existence without downloading
            r = session.head(url, timeout=5, allow_redirects=True)
            
            if r.status_code == 200:
                print(f" [OK] {track['title']}")
                valid_playlist.append(track)
            elif r.status_code == 404:
                print(f" [MISSING] {track['title']} (404 Not Found)")
            else:
                print(f" [WARNING] {track['title']} (Status {r.status_code}) - Keeping just in case")
                valid_playlist.append(track) # Keep non-404 errors (might be transient)
                
        except Exception as e:
            print(f" [ERROR] {track['title']}: {e}")
            # Keep safely if check fails (fallback to download retry logic)
            valid_playlist.append(track)
            
    print(f"Playlist Validation Complete: {len(valid_playlist)}/{len(PLAYLIST)} tracks valid.")
    return valid_playlist

# Run Validation Immediately
PLAYLIST = validate_playlist()

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

# Sequential Playback State
CURRENT_INDEX = 0

def select_next_track():
    """Select next track in strict sequential order (Loop)"""
    global CURRENT_INDEX
    
    if not PLAYLIST:
        print("ERROR: Playlist is empty!")
        # Fallback to a dummy track or crash?
        # But we validated it.
        return None

    # Get current track
    track = PLAYLIST[CURRENT_INDEX]
    print(f"Selected Track [{CURRENT_INDEX + 1}/{len(PLAYLIST)}]: {track['title']}")
    
    # Advance Index (Loop back to 0 at end)
    CURRENT_INDEX = (CURRENT_INDEX + 1) % len(PLAYLIST)
    
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
                    print(f"Failed to load: {track['title']}, skipping...")
                    time.sleep(0.5)  # Fast retry to find next valid track
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
                '-af', 'highpass=f=28,lowshelf=g=7:f=95,equalizer=f=60:width_type=o:width=2:g=4,equalizer=f=800:width_type=o:width=2:g=-3,highshelf=g=9:f=10000,acompressor=threshold=-14dB:ratio=3:attack=8:release=250',
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
        "version": "2.9.9",
        "mode": "local_file_streaming",
        "quality": "320kbps CBR",
        "listeners": len(CLIENTS),
        "queue_size": READY_TRACKS.qsize(),
        "now_playing": now_playing,
        "playlist": [t['title'] for t in PLAYLIST] # Expose bag of songs
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
