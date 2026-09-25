# A/V offset: first blue note highlight in the score (video) vs first audio onset, after the tap on Rest.
import json, sys, subprocess, numpy as np
d = sys.argv[1]
meta = json.load(open(f"{d}/meta.json"))
t0 = meta["frames"][0]["t"]
tap = [m for m in meta["marks"] if m["label"] == "tap-rest"][0]["wall"] / 1000 - t0
import os
FF = os.environ.get("FFMPEG", "ffmpeg")
# video: frames from tap-0.2 s to tap+4 s, score region (full-res 1080x1920)
W, H = 1080, 1920
raw = subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-ss", f"{tap-0.2:.3f}", "-t", "4", "-i", f"{d}/take.mp4",
    "-vf", "crop=920:360:80:740,fps=60", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, 360, 920, 3).astype(int)
blue = ((fr[..., 2] > 180) & (fr[..., 0] < 90) & (fr[..., 1] < 170) & (fr[..., 1] > 60)).sum(axis=(1, 2))
base = blue[:6].mean()
iv = int(np.argmax(blue > base + 40))
tv = tap - 0.2 + iv / 60
# audio
a = np.fromfile(f"{d}/audio.s16le", np.int16).reshape(-1, 2).astype(float) / 32768
start = int((tap - 0.2) * 48000)
env = np.abs(a[start:start + 48000 * 4, 0])
ia = int(np.argmax(env > 0.02))
ta = tap - 0.2 + ia / 48000
print("blue", blue[:40:2].tolist()); print(f"{d}: tap {tap:.3f}  highlight {tv:.3f} (+{tv-tap:.3f})  audio {ta:.3f} (+{ta-tap:.3f})  audio-video {1000*(ta-tv):.0f} ms")
