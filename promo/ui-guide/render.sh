#!/bin/zsh
set -euo pipefail

guide_dir="${0:A:h}"
assets_dir="$guide_dir/assets"
render_dir="$guide_dir/render"
output_file="$guide_dir/自学型熟肉机-操作界面逻辑宣传片.mp4"

mkdir -p "$assets_dir" "$render_dir"
node "$guide_dir/build-assets.mjs"

for svg in "$assets_dir"/scene-*.svg; do
  png="$render_dir/${svg:t:r}.png"
  qlmanage -t -s 1920 -o "$render_dir" "$svg" >/dev/null 2>&1
  ffmpeg -y -hide_banner -loglevel error -i "$render_dir/${svg:t}.png" -vf "crop=1920:1080:0:0" "$png"
done

say -v Tingting -r 255 -f "$guide_dir/voiceover.txt" -o "$render_dir/voiceover.aiff"

durations=(3.8 4.7 5.6 5.2 6.2 6.4 5.5 5.8 3.8 3.0)
for i in {1..10}; do
  scene=$(printf "%s/scene-%02d.png" "$render_dir" "$i")
  clip=$(printf "%s/clip-%02d.mp4" "$render_dir" "$i")
  duration=${durations[$i]}
  zoom_start=$(awk "BEGIN { printf \"%.5f\", 1.000 + ($i % 2) * 0.010 }")
  zoom_step=$(awk "BEGIN { printf \"%.7f\", (($i % 2) ? -0.000022 : 0.000022) }")
  fade_out=$(awk -v d="$duration" 'BEGIN { print d - 0.24 }')
  ffmpeg -y -hide_banner -loglevel error -loop 1 -framerate 30 -i "$scene" -t "$duration" \
    -vf "scale=2112:1188:flags=lanczos,zoompan=z='max(1.0,min(1.025,${zoom_start}+on*${zoom_step}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,format=yuv420p,fade=t=in:st=0:d=0.24,fade=t=out:st=${fade_out}:d=0.24" \
    -an -c:v libx264 -preset veryfast -crf 19 -movflags +faststart "$clip"
done

printf "file '%s'\n" "$render_dir/clip-01.mp4" > "$render_dir/concat.txt"
for i in {2..10}; do printf "file '%s'\n" "$(printf "$render_dir/clip-%02d.mp4" "$i")" >> "$render_dir/concat.txt"; done

ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$render_dir/concat.txt" \
  -f lavfi -t 50 -i "aevalsrc=0.011*sin(2*PI*110*t)+0.007*sin(2*PI*165*t)+0.005*sin(2*PI*220*t):s=48000" \
  -i "$render_dir/voiceover.aiff" \
  -filter_complex "[0:v]subtitles='$guide_dir/voiceover.ass'[v];[1:a]lowpass=f=900,highpass=f=70,afade=t=in:st=0:d=1.2,afade=t=out:st=47.5:d=2.5,volume=0.28[music];[2:a]atempo=1.05,highpass=f=90,lowpass=f=9500,acompressor=threshold=-18dB:ratio=2.2:attack=15:release=160,volume=1.12,adelay=380,apad=pad_dur=50[voice];[music][voice]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.92[a]" \
  -map "[v]" -map "[a]" -t 50 \
  -c:v libx264 -preset veryfast -crf 19 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$output_file"

echo "$output_file"
