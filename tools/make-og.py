"""
Generate the OG card and favicon in the real brand palette and typefaces.

The waveform drawn on the card is a genuine export from the tool, not a
decorative squiggle: it is read from a real mangled WAV and peak-analysed the
same way the app draws it.

    python3 tools/make-og.py <path-to-a-real-mangled.wav>
"""
import struct
import sys
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GROUND = (11, 11, 13)
INK = (237, 231, 220)
INK_DIM = (154, 148, 139)
INK_FAINT = (133, 127, 117)
SIGNAL = (255, 59, 18)
GRID = (25, 24, 26)

W, H = 1200, 630


def read_wav(path):
    """Minimal 24/16-bit PCM WAV reader. Returns mono floats."""
    with open(path, "rb") as f:
        buf = f.read()
    assert buf[0:4] == b"RIFF" and buf[8:12] == b"WAVE", "not a wav"
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(buf):
        cid = buf[pos:pos + 4]
        size = struct.unpack_from("<I", buf, pos + 4)[0]
        body = pos + 8
        if cid == b"fmt ":
            ch, sr = struct.unpack_from("<HI", buf, body + 2)
            bits = struct.unpack_from("<H", buf, body + 14)[0]
            fmt = (ch, sr, bits)
        elif cid == b"data":
            data = (body, size)
        pos = body + size + (size % 2)
    ch, sr, bits = fmt
    start, size = data
    bpс = bits // 8
    frames = size // (bpс * ch)
    out = []
    for i in range(frames):
        acc = 0
        for c in range(ch):
            o = start + (i * ch + c) * bpс
            if bits == 24:
                v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16)
                if v & 0x800000:
                    v -= 0x1000000
                acc += v / 8388608.0
            else:
                v = struct.unpack_from("<h", buf, o)[0]
                acc += v / 32768.0
        out.append(acc / ch)
    return out


def peaks(samples, columns):
    per = len(samples) / columns
    rows = []
    for i in range(columns):
        a = int(i * per)
        b = max(a + 1, int((i + 1) * per))
        chunk = samples[a:b]
        if not chunk:
            rows.append((0.0, 0.0, 0.0))
            continue
        lo, hi = min(chunk), max(chunk)
        rms = (sum(v * v for v in chunk) / len(chunk)) ** 0.5
        rows.append((lo, hi, rms))
    return rows


def load_font(name, size, axes=None):
    path = os.path.join(ROOT, ".fonts", name)
    f = ImageFont.truetype(path, size)
    if axes:
        try:
            f.set_variation_by_axes(axes)
        except Exception as e:  # noqa: BLE001
            print(f"  (variation axes unavailable: {e})")
    return f


def tracked_text(draw, xy, text, font, fill, tracking=0):
    """PIL has no letter-spacing, so step the pen manually."""
    x, y = xy
    for chararacter in text:
        draw.text((x, y), chararacter, font=font, fill=fill)
        x += draw.textlength(chararacter, font=font) + tracking
    return x


def build_og(wav_path):
    img = Image.new("RGB", (W, H), GROUND)
    d = ImageDraw.Draw(img)

    # Rule grid, same rhythm as the app shell.
    for x in range(0, W, 88):
        d.line([(x, 0), (x, H)], fill=GRID, width=1)

    # Waveform from a real export.
    samples = read_wav(wav_path)
    cols = 380
    rows = peaks(samples, cols)
    mid = 322
    half = 128
    col_w = (W - 160) / cols
    for i, (lo, hi, rms) in enumerate(rows):
        x = 80 + i * col_w
        top = mid - hi * half
        bot = mid - lo * half
        d.line([(x, top), (x, max(bot, top + 1))], fill=SIGNAL, width=2)
        r = rms * half
        if r > 1:
            blend = tuple(int(SIGNAL[k] * 0.45 + INK[k] * 0.55) for k in range(3))
            d.line([(x, mid - r), (x, mid + r)], fill=blend, width=2)

    # Baseline through the middle.
    d.line([(80, mid), (W - 80, mid)], fill=(60, 26, 20), width=1)

    # Wordmark.
    mark = load_font("anybody.ttf", 74, axes=[100, 800])
    d.text((78, 74), "sample mangler", font=mark, fill=INK)

    # Standfirst.
    sub = load_font("martian-400.ttf", 19)
    tracked_text(
        d, (82, 168), "DROP A SAMPLE. GET BACK SOMETHING", sub, INK_DIM, 1.6
    )
    tracked_text(
        d, (82, 196), "YOU WOULD NOT HAVE MADE ON PURPOSE.", sub, INK_DIM, 1.6
    )

    # Footer: the actual effect pool, and the privacy fact.
    foot = load_font("martian-700.ttf", 17)
    tracked_text(
        d, (82, 500), "REVERSE · CHOP · BITCRUSH · PITCH · DRIVE", foot, SIGNAL, 2.2
    )
    small = load_font("martian-400.ttf", 16)
    tracked_text(d, (82, 540), "RUNS IN YOUR BROWSER. NOTHING UPLOADS.", small, INK_FAINT, 2.0)

    out = os.path.join(ROOT, "public", "og.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"og.png  {W}x{H}  {os.path.getsize(out)} bytes")


def build_favicon():
    """Four bars at unequal heights. Reads as a waveform even at 16px."""
    svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#0b0b0d"/>
  <g fill="#ff3b12">
    <rect x="5" y="12" width="4" height="8"/>
    <rect x="12" y="4" width="4" height="24"/>
    <rect x="19" y="9" width="4" height="14"/>
    <rect x="26" y="14" width="3" height="4"/>
  </g>
</svg>
"""
    out = os.path.join(ROOT, "public", "favicon.svg")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        f.write(svg)
    print(f"favicon.svg  {os.path.getsize(out)} bytes")


if __name__ == "__main__":
    build_og(sys.argv[1])
    build_favicon()
