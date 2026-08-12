// HAZEN sample mangler — DSP core.
//
// Header only, no dependencies, no allocation in the process paths. This is
// the part of the web tool that ports directly to a plugin: same algorithms,
// same parameter meanings, verified against reference vectors captured from
// the running TypeScript (see native/tests/test_dsp.cpp).
//
// What is NOT here, and why, is documented in native/README.md. The short
// version: pitch shifting and the web build's reverb come from Tone.js, and
// the browser tool renders offline rather than streaming, so those need
// deliberate work rather than a translation.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace hazen {

// ---------------------------------------------------------------- reverse

/// Reverse a block in place. Per channel.
inline void reverse(float* data, std::size_t n) {
  for (std::size_t i = 0; i < n / 2; ++i) std::swap(data[i], data[n - 1 - i]);
}

// --------------------------------------------------------------- bitcrush

/// Sample-and-hold decimation: the sample-rate half of bitcrush.
///
/// Holding each input for `divisor` frames is what produces the aliasing that
/// makes a crushed sample sound like a cheap sampler rather than a quiet one.
/// Stateful across blocks, so a plugin can call it per buffer.
class Decimator {
 public:
  void set_divisor(int divisor) { divisor_ = std::max(1, divisor); }
  void reset() {
    counter_ = 0;
    held_ = 0.0f;
  }

  float process(float x) {
    if (counter_ % divisor_ == 0) held_ = x;
    ++counter_;
    return held_;
  }

 private:
  int divisor_ = 1;
  std::int64_t counter_ = 0;
  float held_ = 0.0f;
};

/// Quantise to `bits` of resolution. The bit-depth half of bitcrush.
inline float quantise(float x, int bits) {
  const float steps = std::pow(2.0f, static_cast<float>(std::max(1, bits)) - 1.0f);
  return std::round(x * steps) / steps;
}

// ------------------------------------------------------------------ drive

/// Tone.js's distortion transfer curve, evaluated analytically.
///
/// The web build feeds this through a WaveShaper with a finite lookup table,
/// so its output carries a little interpolation error. Computing the curve
/// directly is closer to the intent, and matches the browser to within that
/// table's resolution.
inline float drive_curve(float x, float amount) {
  if (x == 0.0f) return 0.0f;
  const float k = amount * 100.0f;
  constexpr float kDeg = 3.14159265358979323846f / 180.0f;
  const float num = (3.0f + k) * x * 20.0f * kDeg;
  const float den = 3.14159265358979323846f + k * std::fabs(x);
  return num / den;
}

// ----------------------------------------------------------------- reverb

/// Schroeder reverb: four parallel combs into two series allpasses.
///
/// Cheap, slightly metallic, and the right amount of space for a chop without
/// dragging in a convolution impulse. Buffers are sized once at prepare().
class Reverb {
 public:
  void prepare(double sample_rate) {
    const double scale = sample_rate / 44100.0;
    static constexpr int kComb[4] = {1557, 1617, 1491, 1422};
    static constexpr int kAllpass[2] = {225, 556};
    for (int i = 0; i < 4; ++i) {
      combs_[i].assign(std::max<std::size_t>(1, static_cast<std::size_t>(kComb[i] * scale)), 0.0f);
      comb_at_[i] = 0;
    }
    for (int i = 0; i < 2; ++i) {
      allpass_[i].assign(std::max<std::size_t>(1, static_cast<std::size_t>(kAllpass[i] * scale)), 0.0f);
      allpass_at_[i] = 0;
    }
  }

  void set_decay(float decay) { decay_ = std::clamp(decay, 0.0f, 0.98f); }
  void set_mix(float mix) { mix_ = std::clamp(mix, 0.0f, 1.0f); }

  void reset() {
    for (auto& b : combs_) std::fill(b.begin(), b.end(), 0.0f);
    for (auto& b : allpass_) std::fill(b.begin(), b.end(), 0.0f);
  }

  float process(float x) {
    float wet = 0.0f;
    for (int i = 0; i < 4; ++i) {
      auto& buf = combs_[i];
      const float y = buf[comb_at_[i]];
      buf[comb_at_[i]] = x + y * decay_;
      comb_at_[i] = (comb_at_[i] + 1) % buf.size();
      wet += y * 0.25f;
    }
    for (int i = 0; i < 2; ++i) {
      auto& buf = allpass_[i];
      const float out = buf[allpass_at_[i]];
      constexpr float g = 0.5f;
      buf[allpass_at_[i]] = wet + out * g;
      wet = out - wet * g;
      allpass_at_[i] = (allpass_at_[i] + 1) % buf.size();
    }
    return x * (1.0f - mix_) + wet * mix_;
  }

 private:
  std::vector<float> combs_[4];
  std::vector<float> allpass_[2];
  std::size_t comb_at_[4]{};
  std::size_t allpass_at_[2]{};
  float decay_ = 0.8f;
  float mix_ = 0.3f;
};

// ------------------------------------------------------------------- level

/// Peak normalise to a ceiling. -1 dBFS by default, matching the web build.
inline void normalise(float* const* channels, int channel_count, std::size_t n,
                      float ceiling = 0.891f) {
  float peak = 0.0f;
  for (int c = 0; c < channel_count; ++c)
    for (std::size_t i = 0; i < n; ++i) peak = std::max(peak, std::fabs(channels[c][i]));
  // Near-silence stays as it is: amplifying it just raises the noise floor.
  if (peak < 1e-5f) return;
  const float gain = ceiling / peak;
  for (int c = 0; c < channel_count; ++c)
    for (std::size_t i = 0; i < n; ++i) channels[c][i] *= gain;
}

/// Fold an overrun back over the head so a loop joins to itself.
///
/// `data` holds `target` frames plus an overlap. The overlap is the material
/// that genuinely followed the loop point, so mixing it into the head makes
/// the last sample lead into the first. Returns the new length, `target`.
///
/// Crossfading the tail toward the head without an overrun does not achieve
/// this: the final sample lands mid-head and the loop then jumps back to
/// head[0]. That version passed a browser test only because both ends were
/// faded to silence afterwards, which is a gap rather than a seam.
inline std::size_t fold_loop_seam(float* data, std::size_t n, std::size_t target) {
  if (target == 0 || target >= n) return std::min(n, target);
  const std::size_t overlap = std::min(n - target, target / 4);
  if (overlap <= 1) return target;
  for (std::size_t i = 0; i < overlap; ++i) {
    const float t = static_cast<float>(i) / static_cast<float>(overlap - 1);
    const float fade_in = std::sin(t * 1.57079632679f);
    const float fade_out = std::cos(t * 1.57079632679f);
    data[i] = data[i] * fade_in + data[target + i] * fade_out;
  }
  return target;
}

}  // namespace hazen
