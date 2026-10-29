"""Synthesizes an original, royalty-free Indian-style background track (raag Bhupali pentatonic):
tanpura drone, sitar-like Karplus-Strong plucks, soft pad and a gentle low pulse.
Usage: python3 tools/compose-music.py <seconds> <out.wav>
"""
import sys
import wave
import numpy as np

SR = 44100
DUR = float(sys.argv[1])
OUT = sys.argv[2]
rng = np.random.default_rng(7)
N = int(DUR * SR)
mix = np.zeros((N, 2))

SA = 261.63  # C4
SCALE = [0, 2, 4, 7, 9]  # Sa Re Ga Pa Dha


def hz(degree, octave=0):
    o, d = divmod(degree, len(SCALE))
    return SA * 2 ** (octave + o + SCALE[d] / 12)


def pluck(freq, seconds, damping=0.996, bright=0.6):
    """Karplus-Strong string with a little 'jawari' buzz for a sitar-like timbre."""
    n = int(seconds * SR)
    period = max(2, int(SR / freq))
    buf = rng.uniform(-1, 1, period) * bright + np.sin(np.linspace(0, 2 * np.pi, period)) * (1 - bright)
    out = np.empty(n)
    for i in range(n):
        j = i % period
        out[i] = buf[j]
        buf[j] = damping * 0.5 * (buf[j] + buf[(j + 1) % period])
    out += 0.12 * np.tanh(4 * out)  # buzz
    return out * np.exp(-np.linspace(0, seconds, n) * 0.8)


def place(sig, start, gain, pan):
    i = int(start * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    mix[i:i + len(sig), 0] += sig * gain * (1 - pan)
    mix[i:i + len(sig), 1] += sig * gain * pan


# Tanpura drone: Pa Sa' Sa' Sa (low), cycling every 3.2 s
t = 0.0
while t < DUR:
    for k, f in enumerate([hz(3, -1), SA, SA, SA / 2]):
        place(pluck(f, 3.5, damping=0.9985, bright=0.35), t + k * 0.8, 0.22, 0.35 + 0.1 * k)
    t += 3.2

# Soft pad (Sa + Pa + Ga), slow swell
tt = np.arange(N) / SR
pad = sum(np.sin(2 * np.pi * f * tt + p) for f, p in [(SA / 2, 0), (hz(3, -1), 1), (hz(2, 0), 2)])
pad *= 0.035 * (1 - np.exp(-tt / 2.5)) * (0.85 + 0.15 * np.sin(2 * np.pi * 0.1 * tt))
mix += np.stack([pad, pad], 1)

# Melody: gentle Bhupali phrases on the sitar-like pluck, 84 bpm
beat = 60 / 84
phrases = [
    [(0, 1), (1, 1), (2, 2), (4, 1), (3, 1), (2, 2)],
    [(2, 1), (3, 1), (4, 1), (5, 1), (4, 2), (3, 2)],
    [(5, 1), (4, 1), (3, 1), (2, 1), (1, 2), (0, 2)],
    [(2, 1), (1, 1), (0, 1), (-1, 1), (0, 4)],
]
t = 1.0
i = 0
while t < DUR - 2.5:
    for deg, length in phrases[i % len(phrases)]:
        if t >= DUR - 2.5:
            break
        place(pluck(hz(deg, 1), 2.2, damping=0.997), t, 0.32, 0.55)
        if length >= 2:  # meend-like grace note
            place(pluck(hz(deg + 1, 1), 0.6, damping=0.99), t + beat * 0.5, 0.08, 0.6)
        t += length * beat * 0.5
    i += 1
    t += beat

# Low pulse on every second beat
thump = np.sin(2 * np.pi * 70 * np.arange(int(0.4 * SR)) / SR) * np.exp(-np.arange(int(0.4 * SR)) / SR * 12)
t = 2.0
while t < DUR - 2:
    place(thump, t, 0.18, 0.5)
    t += beat * 2

# Small room reverb via FFT convolution with a decaying noise tail
ir_len = int(1.6 * SR)
ir = rng.normal(0, 1, (ir_len, 2)) * np.exp(-np.linspace(0, 6, ir_len))[:, None] * 0.015
ir[0] = 1
size = 1 << int(np.ceil(np.log2(N + ir_len)))
wet = np.stack([np.fft.irfft(np.fft.rfft(mix[:, c], size) * np.fft.rfft(ir[:, c], size), size)[:N] for c in range(2)], 1)

# Fade in / out and normalise to -1 dBFS
env = np.minimum(1, tt / 0.4) * np.minimum(1, (DUR - tt) / 2.0)
wet *= env[:, None]
wet *= 0.89 / np.max(np.abs(wet))

with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((wet * 32767).astype("<i2").tobytes())
print(f"wrote {OUT} ({DUR}s)")
