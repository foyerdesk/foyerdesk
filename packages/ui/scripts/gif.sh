#!/bin/sh
# Turns the recorded video into docs/screenshots/demo.gif. Needs ffmpeg. Usage: sh scripts/gif.sh <directory with demo.webm>
set -e
dir="${1:?directory with demo.webm}"
ffmpeg -loglevel error -y -i "$dir/demo.webm" -vf "fps=8,scale=720:-1:flags=lanczos,palettegen=max_colors=64" "$dir/palette.png"
ffmpeg -loglevel error -y -i "$dir/demo.webm" -i "$dir/palette.png" -lavfi "fps=8,scale=720:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" "$dir/demo.gif"
