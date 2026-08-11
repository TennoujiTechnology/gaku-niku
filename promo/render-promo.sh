#!/bin/zsh
set -euo pipefail

promo_dir="${0:A:h}"
assets_dir="$promo_dir/assets"
render_dir="$promo_dir/render"
output_file="$promo_dir/自学型熟肉机-30s介绍.mp4"

mkdir -p "$assets_dir" "$render_dir"

node "$promo_dir/build-assets.mjs"

for svg in "$assets_dir"/scene-*.svg; do
  png="$render_dir/${svg:t:r}.png"
  qlmanage -t -s 1920 -o "$render_dir" "$svg" >/dev/null 2>&1
  ffmpeg -y -hide_banner -loglevel error \
    -i "$render_dir/${svg:t}.png" -vf "crop=1920:1080:0:0" "$png"
done

say -v Tingting -r 255 -f "$promo_dir/voiceover.txt" -o "$render_dir/voiceover.aiff"

durations=(3.2 4.0 5.0 4.5 5.5 4.0 3.8)
for i in {1..7}; do
  scene=$(printf "%s/scene-%02d.png" "$render_dir" "$i")
  clip=$(printf "%s/clip-%02d.mp4" "$render_dir" "$i")
  duration=${durations[$i]}
  zoom_start=$(awk "BEGIN { printf \"%.5f\", 1.000 + ($i % 2) * 0.012 }")
  zoom_step=$(awk "BEGIN { printf \"%.7f\", (($i % 2) ? -0.000035 : 0.000035) }")
  fade_out=$(awk -v d="$duration" 'BEGIN { print d - 0.28 }')
  ffmpeg -y -hide_banner -loglevel error \
    -loop 1 -framerate 30 -i "$scene" \
    -t "$duration" \
    -vf "scale=2304:1296:flags=lanczos,zoompan=z='max(1.0,min(1.035,${zoom_start}+on*${zoom_step}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,format=yuv420p,fade=t=in:st=0:d=0.28,fade=t=out:st=${fade_out}:d=0.28" \
    -an -c:v libx264 -preset veryfast -crf 18 -movflags +faststart "$clip"
done

printf "file '%s'\n" "$render_dir/clip-01.mp4" > "$render_dir/concat.txt"
for i in {2..7}; do
  printf "file '%s'\n" "$(printf "$render_dir/clip-%02d.mp4" "$i")" >> "$render_dir/concat.txt"
done

ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$render_dir/concat.txt" \
  -f lavfi -t 30 -i "aevalsrc=0.012*sin(2*PI*110*t)+0.008*sin(2*PI*165*t)+0.006*sin(2*PI*220*t):s=48000" \
  -i "$render_dir/voiceover.aiff" \
  -filter_complex "[1:a]lowpass=f=900,highpass=f=70,afade=t=in:st=0:d=1.2,afade=t=out:st=28:d=2,volume=0.32[music];[2:a]atempo=1.04,highpass=f=90,lowpass=f=9500,acompressor=threshold=-18dB:ratio=2.2:attack=15:release=160,volume=1.12,adelay=350,apad=pad_dur=30[voice];[music][voice]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.92[a]" \
  -map 0:v -map "[a]" -t 30 \
  -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$output_file"

echo "$output_file"
