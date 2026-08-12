// Verifies the C++ DSP core against reference vectors captured from the
// running TypeScript in the browser. Same input, same parameters, so a
// mismatch means the port drifted rather than that the algorithms differ.
//
//   c++ -std=c++20 -O2 -I native/include native/tests/test_dsp.cpp -o /tmp/test_dsp && /tmp/test_dsp

#include "hazen/dsp.hpp"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace {

int failures = 0;
int checks = 0;

void check(const std::string& name, bool ok, const std::string& detail) {
  ++checks;
  if (!ok) ++failures;
  std::printf("  %s  %-34s  %s\n", ok ? "PASS" : "FAIL", name.c_str(), detail.c_str());
}

/// The same signal the browser generated its reference vectors from.
std::vector<float> test_signal(std::size_t n, double sr) {
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; ++i) {
    const double t = static_cast<double>(i) / sr;
    out[i] = static_cast<float>(std::sin(2 * M_PI * 220 * t) * 0.8 +
                                std::sin(2 * M_PI * 1310 * t) * 0.2);
  }
  return out;
}

double worst_delta(const std::vector<float>& got, const std::vector<double>& want) {
  double worst = 0.0;
  const std::size_t n = std::min(got.size(), want.size());
  for (std::size_t i = 0; i < n; ++i)
    worst = std::max(worst, std::fabs(static_cast<double>(got[i]) - want[i]));
  return worst;
}

// ---- reference vectors, captured from the TypeScript in the browser -------

const std::vector<double> kInput = {
    0,         0.0571631, 0.1133059, 0.1674378, 0.2186259, 0.2660219, 0.3088868,
    0.3466116, 0.3787349, 0.404956,  0.4251426, 0.4393349, 0.4477435, 0.4507426,
    0.448859,  0.4427555, 0.4332113, 0.4210987, 0.407357,  0.3929642, 0.3789082,
    0.366157,  0.3556303, 0.3481715, 0.3445231, 0.3453039, 0.350991,  0.3619048,
    0.3782,    0.3998596, 0.4266962, 0.4583559};

const std::vector<double> kDecimateDiv5 = {
    0,         0,         0,         0,         0,         0.2660219, 0.2660219,
    0.2660219, 0.2660219, 0.2660219, 0.4251426, 0.4251426, 0.4251426, 0.4251426,
    0.4251426, 0.4427555, 0.4427555, 0.4427555, 0.4427555, 0.4427555, 0.3789082,
    0.3789082, 0.3789082, 0.3789082, 0.3789082, 0.3453039, 0.3453039, 0.3453039,
    0.3453039, 0.3453039, 0.4266962, 0.4266962};

const std::vector<double> kDistortion05 = {
    0,         0.1762549, 0.2380159, 0.2690473, 0.2874089, 0.299314,  0.3074664,
    0.3132291, 0.3173598, 0.320311,  0.3223671, 0.3237135, 0.3244759, 0.3247419,
    0.3245753, 0.3240268, 0.3231421, 0.3219689, 0.3205649, 0.3190034, 0.3173804,
    0.3158161, 0.3144528, 0.3134445, 0.3129379, 0.3130472, 0.3138302, 0.3152735,
    0.3172961, 0.3197637, 0.3225182, 0.3254032};

}  // namespace

int main() {
  constexpr double kSr = 48000.0;
  // Long enough that every case below stays in bounds. An earlier version
  // generated 512 frames and then sliced 576, which read past the end and made
  // the seam check pass against garbage.
  const auto signal = test_signal(4096, kSr);

  std::printf("HAZEN dsp core, checked against the browser\n\n");

  // The generator itself must agree, or every later comparison is meaningless.
  {
    std::vector<float> head(signal.begin(), signal.begin() + kInput.size());
    const double d = worst_delta(head, kInput);
    check("test signal matches", d < 1e-6, "max delta " + std::to_string(d));
  }

  // Sample and hold.
  {
    hazen::Decimator dec;
    dec.set_divisor(5);
    std::vector<float> got;
    for (std::size_t i = 0; i < kDecimateDiv5.size(); ++i) got.push_back(dec.process(signal[i]));
    const double d = worst_delta(got, kDecimateDiv5);
    check("decimate /5", d < 1e-6, "max delta " + std::to_string(d));
  }

  // Distortion curve. The browser routes this through a finite WaveShaper
  // table, so its values carry interpolation error; the analytic curve here is
  // closer to the intent and agrees to within that table's resolution.
  {
    std::vector<float> got;
    for (std::size_t i = 0; i < kDistortion05.size(); ++i)
      got.push_back(hazen::drive_curve(signal[i], 0.5f));
    const double d = worst_delta(got, kDistortion05);
    check("drive 0.5 matches Tone", d < 1e-3, "max delta " + std::to_string(d));
  }

  // Quantisation is exact arithmetic, so it can be asserted outright.
  {
    const bool ok = hazen::quantise(0.5f, 2) == 0.5f &&
                    std::fabs(hazen::quantise(0.3f, 2) - 0.5f) < 1e-6f &&
                    std::fabs(hazen::quantise(0.24f, 2) - 0.0f) < 1e-6f;
    check("quantise to 2 bits", ok, "steps land on 0, 0.5, 1.0");
  }

  // Reverse is its own inverse.
  {
    std::vector<float> a(signal.begin(), signal.begin() + 64);
    const std::vector<float> original = a;
    hazen::reverse(a.data(), a.size());
    const bool changed = a != original;
    hazen::reverse(a.data(), a.size());
    check("reverse round trips", changed && a == original, "double reverse is identity");
  }

  // Normalisation must hit the ceiling exactly, and leave silence alone.
  {
    std::vector<float> a(signal.begin(), signal.begin() + 256);
    float* chans[1] = {a.data()};
    hazen::normalise(chans, 1, a.size());
    float peak = 0.0f;
    for (float v : a) peak = std::max(peak, std::fabs(v));
    check("normalise to -1 dBFS", std::fabs(peak - 0.891f) < 1e-5f,
          "peak " + std::to_string(peak));

    std::vector<float> quiet(64, 0.0f);
    float* qc[1] = {quiet.data()};
    hazen::normalise(qc, 1, quiet.size());
    bool still_silent = true;
    for (float v : quiet) still_silent = still_silent && v == 0.0f;
    check("silence is left alone", still_silent, "no gain applied");
  }

  // Reverb has to stay bounded and actually do something.
  {
    hazen::Reverb rv;
    rv.prepare(kSr);
    rv.set_decay(0.82f);
    rv.set_mix(0.5f);
    float peak = 0.0f;
    bool finite = true;
    double energy = 0.0;
    for (std::size_t i = 0; i < signal.size(); ++i) {
      const float y = rv.process(signal[i]);
      finite = finite && std::isfinite(y);
      peak = std::max(peak, std::fabs(y));
      energy += static_cast<double>(y) * y;
    }
    check("reverb stays finite", finite, "no NaN or inf");
    check("reverb does not blow up", peak < 4.0f, "peak " + std::to_string(peak));
    check("reverb produces output", energy > 0.0, "energy " + std::to_string(energy));
  }

  // The loop seam must leave the join continuous, with no fade to hide behind.
  {
    // 480 target frames plus a 96 frame overrun, as the renderer produces.
    std::vector<float> a(signal.begin(), signal.begin() + 576);
    const std::size_t len = hazen::fold_loop_seam(a.data(), a.size(), 480);
    a.resize(len);

    double inner = 0.0;
    for (std::size_t i = 1; i < a.size(); ++i)
      inner += std::fabs(static_cast<double>(a[i]) - a[i - 1]);
    inner /= static_cast<double>(a.size() - 1);
    const double seam = std::fabs(static_cast<double>(a[0]) - a[a.size() - 1]);
    check("length is exact", len == 480, std::to_string(len) + " frames");
    // Guard the guard: a nonsensical baseline means the comparison proved
    // nothing, which is exactly how the first version of this passed.
    check("seam baseline is sane", inner > 0.0 && inner < 1.0,
          "typical step " + std::to_string(inner));
    check("loop seam is not a step", seam <= std::max(inner * 6.0, 0.02),
          "seam " + std::to_string(seam) + " vs typical " + std::to_string(inner));
  }

  std::printf("\n%s  %d checks, %d failed\n",
              failures == 0 ? "ALL PASSED" : "FAILURES", checks, failures);
  return failures == 0 ? 0 : 1;
}
