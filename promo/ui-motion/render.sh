#!/bin/zsh
set -euo pipefail

guide_dir="${0:A:h}"
assets_dir="$guide_dir/assets"
raw_dir="$assets_dir/raw"
render_dir="$guide_dir/render"
output_file="$guide_dir/自学型熟肉机-动态操作宣传片.mp4"
font_file="/System/Library/Fonts/Hiragino Sans GB.ttc"

mkdir -p "$assets_dir" "$render_dir"
for required in prepare.png review.png cue.png; do
  test -f "$raw_dir/$required" || { echo "Missing $raw_dir/$required" >&2; exit 1; }
done

node "$guide_dir/build-assets.mjs"
for name in intro outro; do
  sips -s format png "$assets_dir/$name.svg" --out "$render_dir/$name.png" >/dev/null
done
sips -s format png -z 120 120 "$assets_dir/cursor.svg" --out "$render_dir/cursor.png" >/dev/null

say -v Tingting -r 272 -f "$guide_dir/voiceover.txt" -o "$render_dir/voiceover.aiff"

ffmpeg -y -hide_banner -loglevel error -loop 1 -framerate 30 -i "$render_dir/intro.png" -t 4 \
  -vf "scale=2112:1188:flags=lanczos,zoompan=z='1.075-0.00026*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+24':d=1:s=1920x1080:fps=30,fade=t=in:st=0:d=0.18,fade=t=out:st=3.76:d=0.24,format=yuv420p" \
  -an -c:v libx264 -preset veryfast -crf 18 "$render_dir/scene-01.mp4"

ffmpeg -y -hide_banner -loglevel error -loop 1 -framerate 30 -i "$raw_dir/prepare.png" -loop 1 -framerate 30 -i "$render_dir/cursor.png" -t 7 \
  -filter_complex "[0:v]drawbox=x=330:y=302:w=820:h=82:color=0x5D7DF2@0.95:t=5:enable='between(t,0.8,2.35)',drawbox=x=330:y=686:w=900:h=92:color=0x45D5CC@0.92:t=5:enable='between(t,2.45,4.55)',drawbox=x=1268:y=292:w=315:h=58:color=0xF58CB8@0.95:t=5:enable='between(t,4.65,6.75)',drawtext=fontfile='$font_file':text='① 放入视频':fontsize=34:fontcolor=white:borderw=10:bordercolor=0x101B2C@0.86:x=470:y=220:enable='between(t,0.8,2.35)',drawtext=fontfile='$font_file':text='② 写入研究关键词':fontsize=34:fontcolor=white:borderw=10:bordercolor=0x101B2C@0.86:x=510:y=610:enable='between(t,2.45,4.55)',drawtext=fontfile='$font_file':text='③ 选择 Agent':fontsize=34:fontcolor=white:borderw=10:bordercolor=0x101B2C@0.86:x=1300:y=225:enable='between(t,4.65,6.75)',scale=2112:1188:flags=lanczos,zoompan=z='1.015+0.00012*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30[bg];[1:v]format=rgba[cur];[bg][cur]overlay=x='if(lt(t,1.2),1580-820*t/1.2,if(lt(t,3.4),760,if(lt(t,4.7),760+660*(t-3.4)/1.3,1420)))':y='if(lt(t,1.2),180+135*t/1.2,if(lt(t,3.4),315+385*(t-1.2)/2.2,if(lt(t,4.7),700-390*(t-3.4)/1.3,310)))',fade=t=in:st=0:d=0.18,fade=t=out:st=6.76:d=0.24,format=yuv420p[v]" \
  -map "[v]" -an -c:v libx264 -preset veryfast -crf 18 "$render_dir/scene-02.mp4"

ffmpeg -y -hide_banner -loglevel error -loop 1 -framerate 30 -i "$raw_dir/prepare.png" -loop 1 -framerate 30 -i "$render_dir/cursor.png" -t 6.5 \
  -filter_complex "[0:v]drawbox=x=1260:y=610:w=350:h=274:color=0x45D5CC@0.86:t=5,drawbox=x=1270:y='648+27*t':w=330:h=4:color=0x7DF3E8@0.95:t=fill:enable='between(t,0.7,5.6)',drawbox=x=1260:y=894:w=350:h=72:color=0x5D7DF2@0.95:t=6:enable='between(t,4.7,6.2)',scale=2304:1296:flags=lanczos,zoompan=z='1.08+0.00075*on':x='1745-iw/zoom/2':y='800-ih/zoom/2':d=1:s=1920x1080:fps=30[bg];[1:v]format=rgba[cur];[bg][cur]overlay=x='if(lt(t,4.8),1510,1510-190*(t-4.8)/1.2)':y='if(lt(t,4.8),710,710+170*(t-4.8)/1.2)',fade=t=in:st=0:d=0.18,fade=t=out:st=6.26:d=0.24,drawtext=fontfile='$font_file':text='8 个阶段，每一步都有状态与证据':fontsize=38:fontcolor=white:borderw=12:bordercolor=0x101B2C@0.88:x=80:y=78,format=yuv420p[v]" \
  -map "[v]" -an -c:v libx264 -preset veryfast -crf 18 "$render_dir/scene-03.mp4"

ffmpeg -y -hide_banner -loglevel error -loop 1 -framerate 30 -i "$raw_dir/review.png" -loop 1 -framerate 30 -i "$render_dir/cursor.png" -t 7.5 \
  -filter_complex "[0:v]drawbox=x=55:y=650:w=1530:h=138:color=0x5D7DF2@0.78:t=5:enable='between(t,2.0,7.1)'[marked];[1:v]format=rgba[cur];[marked][cur]overlay=x='if(lt(t,2),1060,1060+420*(t-2)/4.6)':y='if(lt(t,2),460,700)',scale=2112:1188:flags=lanczos,zoompan=z='1.02+0.00044*on':x='iw/2-(iw/zoom/2)':y='if(lt(on,55),0,45+0.28*(on-55))':d=1:s=1920x1080:fps=30,drawtext=fontfile='$font_file':text='看着视频，拖着时间轴精修':fontsize=40:fontcolor=white:borderw=12:bordercolor=0x101B2C@0.88:x=84:y=82,fade=t=in:st=0:d=0.18,fade=t=out:st=7.26:d=0.24,format=yuv420p[v]" \
  -map "[v]" -an -c:v libx264 -preset veryfast -crf 18 "$render_dir/scene-04.mp4"

ffmpeg -y -hide_banner -loglevel error -loop 1 -framerate 30 -i "$raw_dir/cue.png" -loop 1 -framerate 30 -i "$render_dir/cursor.png" -t 7.5 \
  -filter_complex "[0:v]drawbox=x=0:y=735:w=1545:h=78:color=0xF4B942@0.9:t=5:enable='between(t,0.5,3.3)',drawbox=x=1555:y=605:w=340:h=315:color=0xF58CB8@0.9:t=5:enable='between(t,2.5,7.1)',drawbox=x=1650:y=922:w=145:h=44:color=0x45D5CC@0.96:t=5:enable='between(t,5.0,7.1)'[marked];[1:v]format=rgba[cur];[marked][cur]overlay=x='if(lt(t,2.4),650+940*t/2.4,if(lt(t,5.2),1590+110*(t-2.4)/2.8,1700))':y='if(lt(t,2.4),770-80*t/2.4,if(lt(t,5.2),690+245*(t-2.4)/2.8,935))',scale=2188:1231:flags=lanczos,zoompan=z='1.035+0.00034*on':x='if(lt(on,70),iw/2-(iw/zoom/2),1670-iw/zoom/2)':y='790-ih/zoom/2':d=1:s=1920x1080:fps=30,drawtext=fontfile='$font_file':text='低置信度优先复核 · 时间贴合 · OCR 回看':fontsize=38:fontcolor=white:borderw=12:bordercolor=0x101B2C@0.88:x=84:y=82,fade=t=in:st=0:d=0.18,fade=t=out:st=7.26:d=0.24,format=yuv420p[v]" \
  -map "[v]" -an -c:v libx264 -preset veryfast -crf 18 "$render_dir/scene-05.mp4"

ffmpeg -y -hide_banner -loglevel error -loop 1 -framerate 30 -i "$render_dir/outro.png" -t 5.5 \
  -vf "scale=2112:1188:flags=lanczos,zoompan=z='1.055-0.00018*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,fade=t=in:st=0:d=0.22,fade=t=out:st=5.1:d=0.4,format=yuv420p" \
  -an -c:v libx264 -preset veryfast -crf 18 "$render_dir/scene-06.mp4"

for i in {1..6}; do printf "file '%s'\n" "$(printf "$render_dir/scene-%02d.mp4" "$i")"; done > "$render_dir/concat.txt"

ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$render_dir/concat.txt" \
  -f lavfi -t 38 -i "aevalsrc=(0.009*sin(2*PI*92*t)+0.006*sin(2*PI*184*t)+0.010*sin(2*PI*55*t)*exp(-16*mod(t\,0.5))+0.004*sin(2*PI*880*t)*exp(-34*mod(t\,0.25))):s=48000" \
  -i "$render_dir/voiceover.aiff" \
  -filter_complex "[0:v]subtitles='$guide_dir/voiceover.ass'[v];[1:a]highpass=f=55,lowpass=f=2400,afade=t=in:st=0:d=1,afade=t=out:st=35.5:d=2.5,volume=0.72[music];[2:a]atempo=1.04,highpass=f=90,lowpass=f=9500,acompressor=threshold=-18dB:ratio=2.3:attack=12:release=150,volume=1.12,adelay=260,apad=pad_dur=38[voice];[music][voice]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.93[a]" \
  -map "[v]" -map "[a]" -t 38 -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart "$output_file"

echo "$output_file"
