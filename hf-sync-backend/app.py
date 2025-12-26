import os
import time
import threading
import glob
import random
import requests
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
BASE_URL = "https://huggingface.co/spaces/yepzhi/sergradio-sync/resolve/main/tracks/" # Fetch from Space storage
TRACKS_DIR = "tracks"
os.makedirs(TRACKS_DIR, exist_ok=True)

# Playlist: Long Mixes (Hosted on Hugging Face Spaces)
PLAYLIST = [
    {"id": "m1", "title": "Doble B Sat 9 Feb Rec 1", "artist": "Serg", "file": "DOBLE B SAT 9 FEB Rec 1.mp3", "weight": 1},
    {"id": "m2", "title": "Doble B Sat 9 Feb Rec 2", "artist": "Serg", "file": "DOBLE B SAT 9 FEB Rec 2.mp3", "weight": 1},
    {"id": "m3", "title": "Friday I'm In Love Vol. 4", "artist": "Serg", "file": "Friday  Im In Love Vol. 4.mp3", "weight": 1},
    {"id": "m4", "title": "Goodbye 2015 Hello 2016", "artist": "Serg", "file": "Godbye 2015 Hello 2016.mp3", "weight": 1},
    {"id": "m5", "title": "Goodbye 2014 Hello 2015", "artist": "Serg", "file": "GOODBYE 2014 HELLO 2015.mp3", "weight": 1},
    {"id": "m6", "title": "Maxima Weekend Trip", "artist": "Serg", "file": "Maxima Weekend Trip.mp3", "weight": 1},
    {"id": "m7", "title": "Republica De San Pedro", "artist": "Serg", "file": "SERG @ REPUBLICA DE SAN PEDRO.mp3", "weight": 1},
    {"id": "m8", "title": "Backroom Hermosillo", "artist": "Serg", "file": "Serg@Backroom Hermosillo SON DANCE.mp3", "weight": 1},
    {"id": "m9", "title": "The Missing Out Basement", "artist": "Serg", "file": "The Missing Out Basement Invites Serg.mp3", "weight": 1},
    {"id": "m10", "title": "Up In The Club", "artist": "Serg", "file": "UP IN THE CLUB WITH MY HOMIES.mp3", "weight": 1},
]

CLIENTS = []
# Global Circular Buffer for Burst-on-Connect
# Stores last ~6 seconds of audio to fast-fill client buffer (Anti-Starvation)
# 192kbps = 24KB/s. 16KB chunks. 1.5 chunks/s. 10 chunks = ~6 seconds.
BURST_BUFFER = deque(maxlen=10) 
CURRENT_TRACK_INFO = {"title": "Connecting...", "artist": "SERGRadio"}

# Track Manager Queue
READY_TRACKS = Queue(maxsize=2) # Reduced buffer size for large files (storage)

def download_track(filename):
    url = f"{BASE_URL}{filename}"
    local_path = os.path.join(TRACKS_DIR, filename)
    
    # Check if exists and > 10MB (simple check for "not empty")
    if os.path.exists(local_path) and os.path.getsize(local_path) > 10 * 1024 * 1024:
        print(f"Track {filename} found in cache.")
        return local_path
        
    print(f"Downloading {filename}...")
    try:
        # Increase timeout to 30 mins (1800s) for 300MB+ files
        r = requests.get(url, stream=True, timeout=1800)
        if r.status_code == 200:
            with open(local_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=65536):
                    f.write(chunk)
            print(f"Downloaded {filename}")
            return local_path
        else:
            print(f"Failed to download {url}: {r.status_code}")
    except Exception as e:
        print(f"Error downloading {filename}: {e}")
    return None

def track_manager_loop():
    """Background thread to keep READY_TRACKS full of local files"""
    print("Track Manager started...")
    while True:
        try:
            if not READY_TRACKS.full():
                # Even Distribution Shuffle
                selected_track = select_next_track()
                
                # Download (Blocking, but in this separate thread)
                path = download_track(selected_track['file'])
                if path:
                    READY_TRACKS.put({'track': selected_track, 'path': path})
                else:
                    time.sleep(2) # Retry delay if download fails
            else:
                time.sleep(1) # Wait for consumer
        except Exception as e:
            print(f"Track Manager Error: {e}")
            time.sleep(1)

# Broadcast Thread using FFmpeg subprocess
def broadcast_stream():
    global CURRENT_TRACK_INFO
    print("Starting FFmpeg broadcast loop...")
    
    # 16KB chunks to reduce overhead
    CHUNK_SIZE = 16384 
    
    while True:
        # Get next ready track (blocking if empty, but manager should keep it full)
        item = READY_TRACKS.get()
        track = item['track']
        local_path = item['path']
            
        print(f"Now Playing: {track['title']}")
        CURRENT_TRACK_INFO = track
        
        # FFmpeg Command
        cmd = [
            'ffmpeg',
            '-re', 
            '-i', local_path,
            '-f', 'mp3',
            '-b:a', '192k',
            '-bufsize', '512k',
            '-ac', '2',
            '-ar', '44100',
            '-loglevel', 'error',
            'pipe:1'
        ]
        
        try:
            # Popen allows us to read stdout in real-time
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            while True:
                # Read chunk
                chunk = process.stdout.read(CHUNK_SIZE)
                if not chunk:
                    break
                
                # Update Burst Buffer
                BURST_BUFFER.append(chunk)

                # Send to active clients
                dead_clients = []
                for q in CLIENTS:
                    try:
                        if q.full():
                            try:
                                q.get_nowait()
                            except Empty:
                                pass
                        q.put_nowait(chunk)
                    except Exception:
                        dead_clients.append(q)
                
                # Cleanup dead clients
                for q in dead_clients:
                    if q in CLIENTS:
                        CLIENTS.remove(q)
                        
            process.wait()
            
        except Exception as e:
            print(f"Streaming error: {e}")
            time.sleep(1)

# Track Shuffle Bag (Even Distribution)
SHUFFLE_BAG = []

def select_next_track():
    global SHUFFLE_BAG
    if not SHUFFLE_BAG:
        # Refill and shuffle
        SHUFFLE_BAG = list(PLAYLIST)
        random.shuffle(SHUFFLE_BAG)
        print("Refilled Shuffle Bag")
    
    return SHUFFLE_BAG.pop()

# Broadcast Thread using FFmpeg subprocess
def broadcast_stream():
    global CURRENT_TRACK_INFO
    print("Starting FFmpeg broadcast loop...")
    
    # 16KB chunks to reduce overhead
    CHUNK_SIZE = 16384 
    
    while True:
        # Get next ready track (blocking if empty, but manager should keep it full)
        item = READY_TRACKS.get()
        track = item['track']
        local_path = item['path']
            
        print(f"Now Playing: {track['title']}")
        CURRENT_TRACK_INFO = track
        
        # FFmpeg Command
        cmd = [
            'ffmpeg',
            '-re', 
            '-i', local_path,
            '-f', 'mp3',
            '-b:a', '192k',
            '-bufsize', '512k',
            '-ac', '2',
            '-ar', '44100',
            '-loglevel', 'error',
            'pipe:1'
        ]
        
        try:
            # Popen allows us to read stdout in real-time
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            while True:
                # Read chunk
                chunk = process.stdout.read(CHUNK_SIZE)
                if not chunk:
                    break
                
                # Update Burst Buffer
                BURST_BUFFER.append(chunk)

                # Send to active clients
                dead_clients = []
                for q in CLIENTS:
                    try:
                        if q.full():
                            try:
                                q.get_nowait()
                            except Empty:
                                pass
                        q.put_nowait(chunk)
                    except Exception:
                        dead_clients.append(q)
                
                # Cleanup dead clients
                for q in dead_clients:
                    if q in CLIENTS:
                        CLIENTS.remove(q)
                        
            process.wait()
            
        except Exception as e:
            print(f"Streaming error: {e}")
            time.sleep(1)

# Start Background Threads
threading.Thread(target=track_manager_loop, daemon=True).start()
threading.Thread(target=broadcast_stream, daemon=True).start()

@app.get("/")
def index():
    return {
        "status": "radio_active", 
        "quality": "192kbps CBR",
        "listeners": len(CLIENTS),
        "now_playing": CURRENT_TRACK_INFO,
        "queue": READY_TRACKS.qsize()
    }

@app.get("/stream")
def stream_audio():
    def event_stream():
        # Large Client Queue to absorb jitters
        q = Queue(maxsize=500) 
        
        # BURST: Pre-fill
        backlog = list(BURST_BUFFER)
        for chunk in backlog:
            try:
                q.put_nowait(chunk)
            except Full:
                break
                
        CLIENTS.append(q)
        print(f"Client connected. Burst: {len(backlog)}. Total: {len(CLIENTS)}")
        
        try:
            while True:
                chunk = q.get()
                yield chunk
        except Exception as e:
            print(f"Client disconnected: {e}")
        finally:
            if q in CLIENTS:
                CLIENTS.remove(q)

    # Headers to prevent buffering AND Enable CORS for AudioContext
    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
    }
    
    return StreamingResponse(event_stream(), media_type="audio/mpeg", headers=headers)
