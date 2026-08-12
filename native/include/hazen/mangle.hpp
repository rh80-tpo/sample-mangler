// The mangler chain, offline.
//
// This is the plugin's half of the web build's render path. It is deliberately
// offline rather than streaming: the web tool renders once and plays the result,
// which is what makes preview and export identical, and a plugin that streamed
// the chain instead would be a different product with different output. Load a
// sample, render, play the buffer.
//
// Header only and free of JUCE, so the same code compiles into the test harness.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

#include "hazen/dsp.hpp"

namespace hazen {

/// Interleaved-by-channel sample data, matching the web build's Pcm.
struct Audio {
  std::vector<std::vector<float>> channels;
  double sample_rate = 44100.0;

  std::size_t frames() const { return channels.empty() ? 0 : channels[0].size(); }
  int channel_count() const { return static_cast<int>(channels.size()); }
  double seconds() const { return frames() / sample_rate; }

  void resize(int chans, std::size_t n) {
    channels.assign(static_cast<std::size_t>(std::max(1, chans)), std::vector<float>(n, 0.0f));
  }
};

// ------------------------------------------------------------- pitch shift

/// Granular pitch shift. Time preserved, pitch moved.
///
/// Overlap-added Hann grains, each reading the input at `ratio` while restarting
/// at the same position in output time. That is the same family as the grain
/// shifter the web build uses, and it has the same character: short windows
/// stutter, long windows smear. It is not a phase vocoder and does not pretend
/// to be — the artefacts are part of the sound here.
inline void pitch_shift(Audio& audio, double semitones, double window_seconds) {
  if (std::fabs(semitones) < 0.01 || audio.frames() == 0) return;
  const double ratio = std::pow(2.0, semitones / 12.0);
  const std::size_t n = audio.frames();
  const std::size_t win =
      std::max<std::size_t>(64, static_cast<std::size_t>(window_seconds * audio.sample_rate));
  const std::size_t hop = std::max<std::size_t>(1, win / 2);

  for (auto& ch : audio.channels) {
    std::vector<float> out(n, 0.0f);
    std::vector<float> weight(n, 0.0f);
    for (std::size_t start = 0; start < n; start += hop) {
      for (std::size_t i = 0; i < win; ++i) {
        const std::size_t at = start + i;
        if (at >= n) break;
        // Hann, so overlapping grains sum to a flat envelope.
        const float w =
            0.5f - 0.5f * std::cos(2.0f * 3.14159265358979f * static_cast<float>(i) /
                                   static_cast<float>(win - 1));
        const double read = static_cast<double>(start) + static_cast<double>(i) * ratio;
        const std::size_t i0 = static_cast<std::size_t>(read);
        if (i0 + 1 >= n) continue;
        const float frac = static_cast<float>(read - static_cast<double>(i0));
        const float s = ch[i0] * (1.0f - frac) + ch[i0 + 1] * frac;
        out[at] += s * w;
        weight[at] += w;
      }
    }
    for (std::size_t i = 0; i < n; ++i) {
      ch[i] = weight[i] > 1e-6f ? out[i] / weight[i] : 0.0f;
    }
  }
}

// -------------------------------------------------------------------- chop

/// Cut into segments, shuffle some, repeat some, gate some.
///
/// Length is held constant: a repeat steals the following slot rather than
/// pushing the file longer, which is what keeps a bar-locked result bar-locked.
inline void chop(Audio& audio, int segments, float reorder, float repeat, float gate,
                 std::uint32_t seed) {
  const std::size_t n = audio.frames();
  segments = std::max(2, segments);
  if (n < static_cast<std::size_t>(segments) * 8) return;

  // Same small PRNG as the web build's rng, so behaviour is reproducible.
  auto next = [&seed]() {
    seed += 0x6D2B79F5u;
    std::uint32_t t = seed;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<float>((t ^ (t >> 14)) >> 8) / 16777216.0f;
  };

  const std::size_t seg = n / static_cast<std::size_t>(segments);
  std::vector<int> order(static_cast<std::size_t>(segments));
  for (int i = 0; i < segments; ++i) order[static_cast<std::size_t>(i)] = i;

  // Swap pairs in proportion to `reorder` rather than fully shuffling, so the
  // original phrase is still recognisable at low settings.
  const int swaps = static_cast<int>(reorder * static_cast<float>(segments));
  for (int s = 0; s < swaps; ++s) {
    const std::size_t a = static_cast<std::size_t>(next() * static_cast<float>(segments)) %
                          static_cast<std::size_t>(segments);
    const std::size_t b = static_cast<std::size_t>(next() * static_cast<float>(segments)) %
                          static_cast<std::size_t>(segments);
    std::swap(order[a], order[b]);
  }

  for (int i = 0; i < segments; ++i) {
    if (next() < repeat && i > 0) order[static_cast<std::size_t>(i)] = order[static_cast<std::size_t>(i - 1)];
  }

  std::vector<char> muted(static_cast<std::size_t>(segments), 0);
  for (int i = 0; i < segments; ++i) {
    if (next() < gate * 0.5f) muted[static_cast<std::size_t>(i)] = 1;
  }

  const std::size_t fade = std::min<std::size_t>(seg / 8, static_cast<std::size_t>(0.003 * audio.sample_rate));
  for (auto& ch : audio.channels) {
    std::vector<float> out(n, 0.0f);
    for (int i = 0; i < segments; ++i) {
      if (muted[static_cast<std::size_t>(i)]) continue;
      const std::size_t dst = static_cast<std::size_t>(i) * seg;
      const std::size_t src = static_cast<std::size_t>(order[static_cast<std::size_t>(i)]) * seg;
      for (std::size_t j = 0; j < seg && dst + j < n && src + j < n; ++j) {
        float v = ch[src + j];
        if (fade > 1) {
          if (j < fade) v *= static_cast<float>(j) / static_cast<float>(fade);
          else if (j > seg - fade) v *= static_cast<float>(seg - j) / static_cast<float>(fade);
        }
        out[dst + j] = v;
      }
    }
    ch.swap(out);
  }
}

// ---------------------------------------------------------------- sidechain

/// Gain at a moment, for ducking against a kick on the grid.
///
/// Matches the web build: the gain drops over a fixed 4ms attack, then the
/// *reduction* decays exponentially, which is what a compressor does and why a
/// sidechain breathes instead of gating.
inline float duck_gain_at(double seconds, float amount, int kicks_per_bar, float release,
                          double bpm) {
  if (amount <= 0.0f) return 1.0f;
  const double interval = (60.0 / bpm) * (4.0 / std::max(1, kicks_per_bar));
  if (interval <= 0.0) return 1.0f;
  const double since = seconds - std::floor(seconds / interval) * interval;
  constexpr double kAttack = 0.004;
  if (since < kAttack) {
    return 1.0f - amount * static_cast<float>(since / kAttack);
  }
  const double release_time = std::max(0.01, static_cast<double>(release) * interval);
  const double tau = std::max(0.005, release_time / 3.0);
  return 1.0f - amount * static_cast<float>(std::exp(-(since - kAttack) / tau));
}

inline void apply_sidechain(Audio& audio, float amount, int kicks_per_bar, float release,
                            double bpm) {
  if (amount <= 0.0f) return;
  const std::size_t n = audio.frames();
  std::vector<float> env(n);
  for (std::size_t i = 0; i < n; ++i) {
    env[i] = duck_gain_at(static_cast<double>(i) / audio.sample_rate, amount, kicks_per_bar,
                          release, bpm);
  }
  for (auto& ch : audio.channels)
    for (std::size_t i = 0; i < n; ++i) ch[i] *= env[i];
}

// -------------------------------------------------------------------- level

/// Attenuation only, for the reason the web build gives: the render is already
/// normalised to -1 dBFS, so a boost could only clip.
inline void apply_level(Audio& audio, float db) {
  if (db >= 0.0f) return;
  const float gain = db <= -48.0f ? 0.0f : std::pow(10.0f, db / 20.0f);
  for (auto& ch : audio.channels)
    for (auto& s : ch) s *= gain;
}

// ---------------------------------------------------------------- the chain

struct MangleSettings {
  bool reverse_on = false;

  bool chop_on = false;
  int segments = 12;
  float scatter = 0.4f;
  float stutter = 0.3f;
  float gate = 0.1f;

  bool crush_on = false;
  int bits = 8;
  int divisor = 4;

  bool pitch_on = false;
  float semitones = 0.0f;
  float window = 0.06f;

  bool drive_on = false;
  float drive = 0.4f;

  bool verb_on = false;
  /// Feeds Reverb::set_decay. The C++ core has no damping control, so the
  /// plugin does not offer one rather than showing a knob that does nothing.
  float verb_size = 0.6f;
  float verb_mix = 0.4f;

  std::uint32_t seed = 1;
};

/// Run the chain in a fixed order.
///
/// The web build randomises effect order across passes; here the order is fixed
/// because the plugin's controls are all visible at once and a hidden ordering
/// you cannot see or set would be worse than a predictable one.
inline void run_mangle(Audio& audio, const MangleSettings& s) {
  if (audio.frames() == 0) return;

  if (s.reverse_on)
    for (auto& ch : audio.channels) reverse(ch.data(), ch.size());

  if (s.chop_on) chop(audio, s.segments, s.scatter, s.stutter, s.gate, s.seed);

  if (s.pitch_on) pitch_shift(audio, s.semitones, s.window);

  if (s.crush_on) {
    for (auto& ch : audio.channels) {
      Decimator dec;
      dec.set_divisor(s.divisor);
      for (auto& v : ch) v = quantise(dec.process(v), s.bits);
    }
  }

  if (s.drive_on)
    for (auto& ch : audio.channels)
      for (auto& v : ch) v = drive_curve(v, s.drive);

  if (s.verb_on) {
    // One Reverb per channel: sharing one would sum the channels into a single
    // tail and collapse the stereo image.
    for (auto& ch : audio.channels) {
      Reverb verb;
      verb.prepare(audio.sample_rate);
      verb.set_decay(s.verb_size);
      verb.set_mix(s.verb_mix);
      // `process` already returns the dry/wet blend, so there is no second mix
      // here — doing it again would halve the dry signal.
      for (auto& v : ch) v = verb.process(v);
    }
  }

  std::vector<float*> ptrs;
  ptrs.reserve(audio.channels.size());
  for (auto& ch : audio.channels) ptrs.push_back(ch.data());
  normalise(ptrs.data(), audio.channel_count(), audio.frames());
}

/// Trim or pad to an exact bar count, then fold the seam so it loops.
inline void fit_to_bars(Audio& audio, double bars, double bpm) {
  if (bars <= 0.0 || audio.frames() == 0) return;
  const double seconds_per_bar = (60.0 / bpm) * 4.0;
  const std::size_t target =
      static_cast<std::size_t>(std::llround(bars * seconds_per_bar * audio.sample_rate));
  if (target == 0) return;
  // Keep a short overrun so the fold has genuine following material to use.
  const std::size_t seam = static_cast<std::size_t>(0.012 * audio.sample_rate);
  for (auto& ch : audio.channels) ch.resize(target + seam, 0.0f);
  for (auto& ch : audio.channels) {
    const std::size_t kept = fold_loop_seam(ch.data(), ch.size(), target);
    ch.resize(kept);
  }
}

}  // namespace hazen
