// The vocal chopper, offline.
//
// Port of the web build's chopper: find where to cut, build a phrase on a grid,
// arrange four phrases by a pattern. Monophonic — the next hit takes the voice —
// because overlapping chops turn a rhythm into a smear.
//
// Header only and free of JUCE, so the test harness compiles it directly.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <set>
#include <string>
#include <vector>

#include "hazen/mangle.hpp"

namespace hazen {

// ---------------------------------------------------------------------- fft

/// In-place radix-2 FFT. Length must be a power of two.
inline void fft(std::vector<float>& re, std::vector<float>& im) {
  const std::size_t n = re.size();
  if (n < 2) return;
  for (std::size_t i = 1, j = 0; i < n; ++i) {
    std::size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (std::size_t len = 2; len <= n; len <<= 1) {
    const double ang = -2.0 * 3.14159265358979323846 / static_cast<double>(len);
    const float wr = static_cast<float>(std::cos(ang));
    const float wi = static_cast<float>(std::sin(ang));
    for (std::size_t i = 0; i < n; i += len) {
      float cur_r = 1.0f, cur_i = 0.0f;
      for (std::size_t k = 0; k < len / 2; ++k) {
        const float ur = re[i + k], ui = im[i + k];
        const float vr = re[i + k + len / 2] * cur_r - im[i + k + len / 2] * cur_i;
        const float vi = re[i + k + len / 2] * cur_i + im[i + k + len / 2] * cur_r;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const float nr = cur_r * wr - cur_i * wi;
        cur_i = cur_r * wi + cur_i * wr;
        cur_r = nr;
      }
    }
  }
}

// ------------------------------------------------------------------- onsets

/// Transient positions as frame indices, by spectral flux.
///
/// A vocal's consonants are the onsets worth cutting on, and they appear as
/// broadband energy arriving where there was none.
inline std::vector<std::size_t> detect_onsets(const Audio& audio, float sensitivity = 1.4f) {
  constexpr std::size_t kWin = 1024;
  constexpr std::size_t kHop = 256;
  const std::size_t total = audio.frames();
  if (total < kWin * 4) return {0};
  const std::size_t frames = (total - kWin) / kHop;
  if (frames < 4) return {0};

  std::vector<float> flux(frames, 0.0f);
  std::vector<float> prev(kWin / 2, 0.0f);
  std::vector<float> window(kWin);
  for (std::size_t i = 0; i < kWin; ++i) {
    window[i] = 0.5f - 0.5f * std::cos(2.0f * 3.14159265358979f * static_cast<float>(i) /
                                       static_cast<float>(kWin - 1));
  }

  for (std::size_t f = 0; f < frames; ++f) {
    std::vector<float> re(kWin, 0.0f), im(kWin, 0.0f);
    const std::size_t at = f * kHop;
    for (std::size_t i = 0; i < kWin; ++i) {
      float v = 0.0f;
      for (const auto& ch : audio.channels) v += ch[at + i];
      re[i] = (v / static_cast<float>(audio.channel_count())) * window[i];
    }
    fft(re, im);
    float sum = 0.0f;
    for (std::size_t k = 1; k < kWin / 2; ++k) {
      const float mag = std::sqrt(re[k] * re[k] + im[k] * im[k]);
      const float d = mag - prev[k];
      if (d > 0.0f) sum += d;
      prev[k] = mag;
    }
    flux[f] = sum;
  }

  std::vector<std::size_t> onsets;
  constexpr std::size_t kSpan = 12;
  const std::size_t min_gap = static_cast<std::size_t>((0.06 * audio.sample_rate) / kHop);
  std::ptrdiff_t last = -static_cast<std::ptrdiff_t>(min_gap);
  for (std::size_t f = 1; f + 1 < frames; ++f) {
    float mean = 0.0f;
    std::size_t count = 0;
    const std::size_t lo = f > kSpan ? f - kSpan : 0;
    const std::size_t hi = std::min(frames, f + kSpan);
    for (std::size_t j = lo; j < hi; ++j) {
      mean += flux[j];
      ++count;
    }
    mean /= static_cast<float>(std::max<std::size_t>(1, count));
    const bool peak = flux[f] > flux[f - 1] && flux[f] >= flux[f + 1];
    if (peak && flux[f] > mean * sensitivity &&
        static_cast<std::ptrdiff_t>(f) - last >= static_cast<std::ptrdiff_t>(min_gap)) {
      onsets.push_back(f * kHop);
      last = static_cast<std::ptrdiff_t>(f);
    }
  }
  if (onsets.empty() || onsets.front() > static_cast<std::size_t>(audio.sample_rate * 0.05)) {
    onsets.insert(onsets.begin(), 0);
  }
  return onsets;
}

struct Slice {
  std::size_t start = 0;
  std::size_t end = 0;
};

inline std::vector<Slice> slices_from_onsets(const Audio& audio,
                                            const std::vector<std::size_t>& onsets) {
  const std::size_t total = audio.frames();
  std::vector<Slice> out;
  for (std::size_t i = 0; i < onsets.size(); ++i) {
    const std::size_t start = onsets[i];
    const std::size_t end = i + 1 < onsets.size() ? onsets[i + 1] : total;
    if (end > start && end - start > static_cast<std::size_t>(audio.sample_rate * 0.03)) {
      out.push_back({start, end});
    }
  }
  if (out.empty()) out.push_back({0, total});
  return out;
}

/// Cut on a grid instead of on transients.
///
/// Whole slices only, so every one is the same length and sits on a grid
/// multiple. Near-silent slices are dropped: on a grid a chunk can land in a gap
/// between phrases, and offering silence as chop material puts holes in the loop.
inline std::vector<Slice> slices_from_grid(const Audio& audio, double bpm, int per_bar) {
  const std::size_t total = audio.frames();
  const double seconds_per_bar = (60.0 / bpm) * 4.0;
  const std::size_t len = std::max<std::size_t>(
      1, static_cast<std::size_t>(std::llround((seconds_per_bar / std::max(1, per_bar)) *
                                               audio.sample_rate)));
  std::vector<Slice> whole;
  for (std::size_t start = 0; start + len <= total; start += len) {
    whole.push_back({start, start + len});
  }
  if (whole.empty()) return {{0, total}};

  std::vector<float> levels;
  levels.reserve(whole.size());
  for (const auto& sl : whole) {
    double sum = 0.0;
    std::size_t count = 0;
    for (const auto& ch : audio.channels) {
      for (std::size_t i = sl.start; i < sl.end; i += 4) {
        sum += static_cast<double>(ch[i]) * ch[i];
        ++count;
      }
    }
    levels.push_back(count ? static_cast<float>(std::sqrt(sum / static_cast<double>(count))) : 0.0f);
  }
  const float loudest = *std::max_element(levels.begin(), levels.end());
  const float floor_level = loudest * 0.05f;
  std::vector<Slice> kept;
  for (std::size_t i = 0; i < whole.size(); ++i) {
    if (levels[i] > floor_level) kept.push_back(whole[i]);
  }
  return kept.empty() ? whole : kept;
}

// ------------------------------------------------------------------ pattern

enum class Pattern { AAAB, ABAB, AABA, ABAC, AAAA, ABCB };

inline std::array<int, 4> pattern_letters(Pattern p) {
  switch (p) {
    case Pattern::AAAB: return {0, 0, 0, 1};
    case Pattern::ABAB: return {0, 1, 0, 1};
    case Pattern::AABA: return {0, 0, 1, 0};
    case Pattern::ABAC: return {0, 1, 0, 2};
    case Pattern::AAAA: return {0, 0, 0, 0};
    case Pattern::ABCB: return {0, 1, 2, 1};
  }
  return {0, 0, 0, 1};
}

struct ChopSettings {
  double bpm = 120.0;
  Pattern pattern = Pattern::AAAB;
  float density = 0.55f;
  float variation = 0.6f;
  int resolution = 16;   ///< placement grid, steps per bar
  int phrase_bars = 4;   ///< 4 gives a 16 bar loop
  float hold = 0.25f;
  int cut_per_bar = 0;   ///< 0 means cut on transients
  std::uint32_t seed = 1;
};

/// Rhythmic weight per step, so hits land like a groove rather than a stutter.
inline float grid_weight(int step, int resolution) {
  const int per_beat = std::max(1, resolution / 4);
  if (resolution > 0 && step % resolution == 0) return 1.0f;
  if (step % per_beat == 0) {
    const int beat = step / per_beat;
    return beat % 2 == 0 ? 0.85f : 0.7f;
  }
  if (per_beat >= 4 && step % (per_beat / 2) == 0) return 0.45f;
  return 0.28f;
}

struct Voice {
  std::size_t start = 0;
  std::size_t end = 0;
  int slice = 0;
};

struct ChopResult {
  Audio audio;
  int slice_count = 0;
  int onset_count = 0;
  int bars = 0;
  std::vector<Voice> voices;
};

/// Build the loop.
inline ChopResult build_chop(const Audio& source, const ChopSettings& s) {
  ChopResult result;
  if (source.frames() == 0) return result;

  std::uint32_t state = s.seed;
  auto next = [&state]() {
    state += 0x6D2B79F5u;
    std::uint32_t t = state;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<float>((t ^ (t >> 14)) >> 8) / 16777216.0f;
  };

  std::vector<std::size_t> onsets;
  std::vector<Slice> slices;
  if (s.cut_per_bar <= 0) {
    onsets = detect_onsets(source);
    slices = slices_from_onsets(source, onsets);
  } else {
    slices = slices_from_grid(source, s.bpm, s.cut_per_bar);
  }
  result.onset_count = static_cast<int>(onsets.size());
  result.slice_count = static_cast<int>(slices.size());
  if (slices.empty()) return result;

  const double seconds_per_bar = (60.0 / s.bpm) * 4.0;
  const std::size_t step_samples = std::max<std::size_t>(
      1, static_cast<std::size_t>(std::llround((seconds_per_bar / s.resolution) * source.sample_rate)));
  const std::size_t phrase_samples =
      static_cast<std::size_t>(std::llround(s.phrase_bars * seconds_per_bar * source.sample_rate));
  const int steps = s.phrase_bars * s.resolution;

  const auto letters = pattern_letters(s.pattern);
  std::set<int> unique(letters.begin(), letters.end());

  struct Phrase {
    Audio audio;
    std::vector<Voice> voices;
  };
  std::vector<Phrase> rendered(3);

  for (int letter : unique) {
    const float spice =
        letter == 0 ? 0.0f : s.variation * (letter == 1 ? 1.0f : 1.25f);

    struct Placement {
      int step;
      Slice slice;
      int slice_index;
      float gain;
    };
    std::vector<Placement> placements;
    int cursor = static_cast<int>(next() * static_cast<float>(slices.size()));
    for (int step = 0; step < steps; ++step) {
      const int in_bar = step % s.resolution;
      const float weight = grid_weight(in_bar, s.resolution);
      const bool force = step == 0;
      const float late =
          static_cast<float>(step) / static_cast<float>(steps) > 0.6f ? spice * 0.5f : 0.0f;
      const float chance = std::min(1.0f, s.density * weight + late);
      if (!force && next() > chance) continue;

      if (next() < 0.7f + (1.0f - spice) * 0.2f) cursor += 1;
      else cursor = static_cast<int>(next() * static_cast<float>(slices.size()));
      const int idx = static_cast<int>(((cursor % static_cast<int>(slices.size())) +
                                        static_cast<int>(slices.size())) %
                                       static_cast<int>(slices.size()));
      placements.push_back({step, slices[static_cast<std::size_t>(idx)], idx, 0.82f + next() * 0.18f});
    }

    Phrase phrase;
    phrase.audio.sample_rate = source.sample_rate;
    phrase.audio.resize(source.channel_count(), phrase_samples);

    for (std::size_t p = 0; p < placements.size(); ++p) {
      const auto& pl = placements[p];
      const std::size_t at = static_cast<std::size_t>(pl.step) * step_samples;
      if (at >= phrase_samples) continue;
      const int next_step = p + 1 < placements.size() ? placements[p + 1].step : steps;
      // One voice at a time: the next hit takes it.
      const std::size_t slot =
          std::max(step_samples, static_cast<std::size_t>(next_step - pl.step) * step_samples);
      const std::size_t natural = pl.slice.end - pl.slice.start;
      const std::size_t to_end = source.frames() - pl.slice.start;
      // Hold lifts how much material the voice gets, not how long it may
      // overlap, so a chop can ring past its own transient without ever
      // becoming a second voice.
      const std::size_t reach = natural + static_cast<std::size_t>(
                                              static_cast<double>(to_end - natural) * s.hold);
      const std::size_t len = std::min({reach, slot, phrase_samples - at});
      if (len == 0) continue;

      const std::size_t fade =
          std::min<std::size_t>(static_cast<std::size_t>(0.004 * source.sample_rate), len / 2);
      const std::size_t release =
          std::min<std::size_t>(static_cast<std::size_t>(0.006 * source.sample_rate), len / 2);
      for (int c = 0; c < phrase.audio.channel_count(); ++c) {
        const auto& src = source.channels[static_cast<std::size_t>(
            std::min(c, source.channel_count() - 1))];
        auto& dst = phrase.audio.channels[static_cast<std::size_t>(c)];
        for (std::size_t i = 0; i < len; ++i) {
          float v = src[pl.slice.start + i] * pl.gain;
          if (fade > 0 && i < fade) v *= static_cast<float>(i) / static_cast<float>(fade);
          else if (release > 0 && i > len - release)
            v *= static_cast<float>(len - i) / static_cast<float>(release);
          dst[at + i] = v;  // assignment: nothing else owns these frames
        }
      }
      phrase.voices.push_back({at, at + len, pl.slice_index});
    }
    rendered[static_cast<std::size_t>(letter)] = std::move(phrase);
  }

  const std::size_t total = phrase_samples * letters.size();
  result.audio.sample_rate = source.sample_rate;
  result.audio.resize(source.channel_count(), total);
  for (std::size_t idx = 0; idx < letters.size(); ++idx) {
    const auto& phrase = rendered[static_cast<std::size_t>(letters[idx])];
    const std::size_t at = idx * phrase_samples;
    for (int c = 0; c < result.audio.channel_count(); ++c) {
      const auto& src = phrase.audio.channels[static_cast<std::size_t>(
          std::min(c, phrase.audio.channel_count() - 1))];
      auto& dst = result.audio.channels[static_cast<std::size_t>(c)];
      for (std::size_t i = 0; i < src.size() && at + i < total; ++i) dst[at + i] = src[i];
    }
    for (const auto& v : phrase.voices) {
      result.voices.push_back({at + v.start, at + v.end, v.slice});
    }
  }

  std::vector<float*> ptrs;
  ptrs.reserve(result.audio.channels.size());
  for (auto& ch : result.audio.channels) ptrs.push_back(ch.data());
  normalise(ptrs.data(), result.audio.channel_count(), result.audio.frames());

  result.bars = s.phrase_bars * static_cast<int>(letters.size());
  return result;
}

}  // namespace hazen
