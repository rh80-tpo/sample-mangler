// Drives the real plugin processor headlessly: load a file, render, pull audio.
//
// This is the check that matters. A bundle that loads is not the same as a
// plugin that makes sound, and the only way to know is to call processBlock and
// measure what comes out.

#include <juce_audio_processors/juce_audio_processors.h>
#include <cstdio>
#include "../plugin/Source/PluginProcessor.h"

static void writeTestWav(const juce::File& f) {
  const double sr = 44100.0;
  const int n = int(sr * 4);
  juce::AudioBuffer<float> buf(1, n);
  auto* d = buf.getWritePointer(0);
  double ph = 0.0;
  for (int b = 0; b < 10; ++b) {
    const int at = int((b * 0.38 + 0.05) * sr), len = int(0.30 * sr);
    const double fr = 220.0 + b * 13.0;
    for (int i = 0; i < len && at + i < n; ++i) {
      const double t = i / sr, e = juce::jmin(1.0, i / 200.0) * std::exp(-t * 4);
      ph += 2.0 * juce::MathConstants<double>::pi * fr / sr;
      d[at + i] += float((std::sin(ph) * 0.5 + std::sin(ph * 3.2) * 0.25) * e * 0.8);
    }
  }
  f.deleteFile();
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::FileOutputStream> os(f.createOutputStream());
  std::unique_ptr<juce::AudioFormatWriter> w(fmt.createWriterFor(os.get(), sr, 1, 16, {}, 0));
  if (w) { os.release(); w->writeFromAudioSampleBuffer(buf, 0, n); }
}

static double pullRms(HazenSamplerProcessor& p, int blocks, int blockSize) {
  juce::AudioBuffer<float> out(2, blockSize);
  juce::MidiBuffer midi;
  // note on, so the sampler triggers
  midi.addEvent(juce::MidiMessage::noteOn(1, 60, 1.0f), 0);
  double sum = 0.0; int count = 0;
  for (int b = 0; b < blocks; ++b) {
    out.clear();
    p.processBlock(out, midi);
    midi.clear();
    for (int c = 0; c < out.getNumChannels(); ++c)
      for (int i = 0; i < blockSize; ++i) { const float v = out.getSample(c, i); sum += v * v; ++count; }
  }
  return count ? std::sqrt(sum / count) : 0.0;
}

int main() {
  juce::ScopedJuceInitialiser_GUI juceInit;
  int failures = 0;
  auto check = [&](const char* name, bool ok, const juce::String& note) {
    printf("  %s  %-42s %s\n", ok ? "PASS" : "FAIL", name, note.toRawUTF8());
    if (!ok) ++failures;
  };

  const auto wav = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("hazen_harness.wav");
  writeTestWav(wav);
  check("test file written", wav.existsAsFile() && wav.getSize() > 1000,
        juce::String(wav.getSize()) + " bytes");

  HazenSamplerProcessor p;
  p.setPlayConfigDetails(0, 2, 44100.0, 512);
  p.prepareToPlay(44100.0, 512);

  check("loads a wav", p.loadSample(wav), p.sampleName());

  // The render runs on a background thread; wait for it rather than racing it.
  for (int i = 0; i < 200 && (p.isRendering() || p.renderedSeconds() <= 0.0); ++i)
    juce::Thread::sleep(25);
  check("renders something", p.renderedSeconds() > 0.0,
        juce::String(p.renderedSeconds(), 3) + "s rendered");

  const double mangleRms = pullRms(p, 40, 512);
  check("mangle mode makes sound", mangleRms > 0.005, "rms " + juce::String(mangleRms, 5));

  // 2 bars at 120 is exactly 4 seconds.
  check("mangle fits the bar count", std::abs(p.renderedSeconds() - 4.0) < 0.01,
        juce::String(p.renderedSeconds(), 4) + "s for 2 bars @120");

  // Switch to chop mode through the parameter, the way a host would.
  if (auto* mode = p.params.getParameter("mode")) {
    mode->beginChangeGesture();
    mode->setValueNotifyingHost(1.0f);
    mode->endChangeGesture();
  }
  p.invalidate();
  for (int i = 0; i < 300 && (p.isRendering() || std::abs(p.renderedSeconds() - 4.0) < 0.01); ++i)
    juce::Thread::sleep(25);
  check("chop mode renders 16 bars", std::abs(p.renderedSeconds() - 32.0) < 0.05,
        juce::String(p.renderedSeconds(), 3) + "s (want 32.0)");

  const double chopRms = pullRms(p, 40, 512);
  check("chop mode makes sound", chopRms > 0.005, "rms " + juce::String(chopRms, 5));

  // Level must reach the audio.
  if (auto* lvl = p.params.getParameter("level")) {
    lvl->beginChangeGesture();
    lvl->setValueNotifyingHost(lvl->convertTo0to1(-12.0f));
    lvl->endChangeGesture();
  }
  p.invalidate();
  juce::Thread::sleep(400);
  for (int i = 0; i < 200 && p.isRendering(); ++i) juce::Thread::sleep(25);
  const double quiet = pullRms(p, 40, 512);
  const double ratio = chopRms > 0 ? quiet / chopRms : 0.0;
  check("level -12dB attenuates", ratio > 0.15 && ratio < 0.40,
        "rms ratio " + juce::String(ratio, 4) + " (want ~0.251)");

  // --- rechop, and the rack in chop mode -------------------------------
  // Both were broken: the chop seed was hardcoded so every chop of a setup was
  // byte-identical, and run_mangle was never called in chop mode so the whole
  // rack was dead there.
  auto fingerprint = [&](HazenSamplerProcessor& proc) {
    juce::AudioBuffer<float> out(2, 512);
    juce::MidiBuffer midi;
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, 1.0f), 0);
    juce::int64 hash = 0;
    for (int b = 0; b < 30; ++b) {
      out.clear();
      proc.processBlock(out, midi);
      midi.clear();
      for (int i = 0; i < 512; i += 7)
        hash = hash * 31 + juce::roundToInt(out.getSample(0, i) * 1e6);
    }
    return hash;
  };
  auto settle = [&] {
    juce::Thread::sleep(300);
    for (int i = 0; i < 200 && p.isRendering(); ++i) juce::Thread::sleep(25);
    juce::Thread::sleep(120);
  };

  const auto chopA = fingerprint(p);
  p.rechop();
  settle();
  const auto chopB = fingerprint(p);
  check("rechop gives a different chop", chopA != chopB,
        juce::String(chopA) + " then " + juce::String(chopB));

  check("the rack is off to begin with", !p.rackActive(), "no module on");
  if (auto* verb = p.params.getParameter("verbon")) {
    verb->beginChangeGesture();
    verb->setValueNotifyingHost(1.0f);
    verb->endChangeGesture();
  }
  p.invalidate();
  settle();
  check("the rack reaches chop mode", p.rackActive() && fingerprint(p) != chopB,
        "verb on changed the loop");

  p.chopAndMangle();
  settle();
  check("chop + mangle renders", p.renderedSeconds() > 0.0,
        juce::String(p.renderedSeconds(), 2) + "s after chop + mangle");

  // --- transport and export --------------------------------------------
  p.stopPlayback();
  check("stop leaves it silent", !p.isPlaying(), "not playing");

  p.startPlayback();
  check("play starts it", p.isPlaying(), "playing");
  {
    // Play must begin at the top, and rechop must send it back there.
    juce::AudioBuffer<float> out(2, 256);
    juce::MidiBuffer none;
    out.clear();
    p.processBlock(out, none);
    const float firstAfterPlay = out.getSample(0, 0);
    for (int b = 0; b < 20; ++b) { out.clear(); p.processBlock(out, none); }
    p.startPlayback();
    out.clear();
    p.processBlock(out, none);
    check("play restarts from the beginning",
          std::abs(out.getSample(0, 0) - firstAfterPlay) < 1.0e-6f,
          "same first sample both times");
  }

  {
    // Rechopping mid-playback has to send the playhead home, not leave it
    // wherever the previous loop happened to be.
    p.startPlayback();
    juce::AudioBuffer<float> out(2, 256);
    juce::MidiBuffer none;
    for (int b = 0; b < 40; ++b) { out.clear(); p.processBlock(out, none); }
    const float mid = p.playPosition();
    p.rechop();
    settle();
    out.clear();
    p.processBlock(out, none);
    const float after = p.playPosition();
    check("rechop restarts from the beginning", mid > 0.0f && after < mid,
          "was at " + juce::String(mid, 5) + ", now " + juce::String(after, 5));
  }

  {
    const auto wav = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("hazen_export_check.wav");
    check("exports a wav", p.exportTo(wav) && wav.getSize() > 1000,
          juce::String(wav.getSize()) + " bytes");

    // It has to be a real, readable file, or the drag hands the host garbage.
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> back(fm.createReaderFor(wav));
    const double seconds = back ? double(back->lengthInSamples) / back->sampleRate : 0.0;
    check("the export decodes back", back != nullptr && std::abs(seconds - p.renderedSeconds()) < 0.01,
          back ? juce::String(seconds, 3) + "s, " + juce::String(back->bitsPerSample) + " bit"
               : "unreadable");
    wav.deleteFile();

    const auto dragFile = p.writeDragFile();
    check("the drag file is written", dragFile.existsAsFile() && dragFile.getSize() > 1000,
          dragFile.getFileName());
    check("the drag file is named usefully", dragFile.getFileName().contains("bpm"),
          dragFile.getFileName());
  }
  p.stopPlayback();

  check("state round trips", [&] {
    juce::MemoryBlock mb; p.getStateInformation(mb);
    if (mb.getSize() == 0) return false;
    p.setStateInformation(mb.getData(), int(mb.getSize()));
    return true;
  }(), "saved and restored");

  printf("\n%s  %d checks failed\n", failures ? "FAILED" : "ALL PASSED", failures);
  return failures ? 1 : 0;
}
