# Managed toolchain payloads

Release builds may place verified `uv` executables here before packaging:

- `macos-arm64/uv`
- `macos-arm64/uvx`
- `macos-x64/uv`
- `macos-x64/uvx`
- `windows-arm64/uv.exe`
- `windows-arm64/uvx.exe`
- `windows-x64/uv.exe`
- `windows-x64/uvx.exe`

Release packages may also place platform-native `ffmpeg`, `ffprobe`, and
`yt-dlp` executables in the same target folder. The bridge prefers these
packaged tools, then falls back to the user's `PATH`. Agent CLIs remain
external adapters so their existing logins and credentials are never copied
into the project.

If the matching executable is absent, the local bridge downloads the pinned
asset from `runtime-manifest.json` only after the user confirms environment
installation. The downloaded archive is SHA256-verified before extraction.
