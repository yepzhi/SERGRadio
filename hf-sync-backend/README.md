---
title: hopRadio Sync
emoji: 📻
colorFrom: red
colorTo: yellow
sdk: docker
pinned: false
---

# hopRadio Sync API

Backend API for synchronized radio playback.

## Endpoints

- `GET /` - Health check
- `GET /now-playing` - Returns current track and position
- `GET /playlist` - Returns full playlist

## Usage

All hopRadio users connect to `/now-playing` to get the current synchronized position.
