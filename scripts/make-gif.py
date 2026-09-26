# Turns frames from scripts/record-demo.mjs into a GIF (needs Pillow).
# Waits on the model play 5x faster and are labelled as sped up.
import json, sys
from PIL import Image, ImageDraw, ImageFont
SP = sys.argv[1]; OUT = sys.argv[2]
BUSY = sys.argv[3] if len(sys.argv) > 3 else '>> the in-app AI (OpenAI) is working - sped up 5x'
meta = json.load(open(f'{SP}/frames.json'))
W, H = 960, 600
FPS = 8
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 15)
except Exception:
    font = ImageFont.load_default()
# virtual timeline: waiting on the model plays 5x faster
vt, t_prev, timeline = 0.0, meta[0]['t'], []
for m in meta:
    dt = (m['t'] - t_prev) / 1000
    t_prev = m['t']
    vt += dt * (0.2 if m['busy'] else 1.0)
    timeline.append((vt, m))
frames, durations = [], []
step, nxt, i = 1 / FPS, 0.0, 0
while i < len(timeline):
    while i < len(timeline) - 1 and timeline[i + 1][0] <= nxt:
        i += 1
    m = timeline[i][1]
    im = Image.open(m['f']).convert('RGB').resize((W, H), Image.LANCZOS)
    if m['busy']:
        d = ImageDraw.Draw(im)
        label = BUSY
        tw = d.textlength(label, font=font)
        d.rounded_rectangle([W - tw - 34, H - 118, W - 14, H - 88], radius=14, fill=(107, 85, 201))
        d.text((W - tw - 24, H - 112), label, font=font, fill=(255, 255, 255))
    frames.append(im)
    durations.append(int(1000 / FPS))
    nxt += step
    if nxt > timeline[-1][0]:
        break
durations[-1] = 3500
# one palette learned from frames across the whole run: accents stay true, frames diff well
picks = [frames[int(k * (len(frames) - 1) / 23)] for k in range(24)]
sheet = Image.new('RGB', (W, H * len(picks)))
for k, f in enumerate(picks):
    sheet.paste(f, (0, H * k))
pal = sheet.quantize(colors=256, method=Image.Quantize.FASTOCTREE)
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
q[0].save(OUT, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(len(frames), 'frames', sum(durations) / 1000, 's')
