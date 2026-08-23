# Managed toolchain payloads

Release builds place verified `uv`, `ffmpeg`, and `ffprobe` executables here before packaging:

- `macos-arm64/uv`
- `macos-arm64/uvx`
- `macos-x64/uv`
- `macos-x64/uvx`
- `windows-arm64/uv.exe`
- `windows-arm64/uvx.exe`
- `windows-x64/uv.exe`
- `windows-x64/uvx.exe`

The bridge copies packaged media tools into the selected project's managed
runtime. If they are absent from a development checkout, the confirmed
environment setup downloads the direct binaries pinned in
`runtime-manifest.json`, verifies each SHA256, and then validates both with
`-version`. It does not modify the system `PATH` or a system package manager.
`yt-dlp` may also be provided in the same target folder. Agent CLIs remain
external adapters so their existing logins and credentials are never copied
into the project.

All network installation remains gated by the user's environment-download
confirmation in the Studio UI.
