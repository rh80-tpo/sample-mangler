// Render the plugin editor to a PNG, headlessly.
//
// The reason this exists: `screencapture` needs a Screen Recording permission
// this environment does not have, so the editor shipped once without anyone
// having looked at it, and the layout was wrong. A component can be snapshotted
// straight to an image without a window, which means the UI can be checked the
// same way the web build's is.

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <cstdio>
#include <functional>

#include "../plugin/Source/PluginProcessor.h"
#include "../plugin/Source/PluginEditor.h"

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

static void shoot(HazenSamplerProcessor& p, const char* name) {
  std::unique_ptr<juce::AudioProcessorEditor> ed(p.createEditor());
  if (ed == nullptr) { printf("no editor\n"); return; }
  ed->setBounds(0, 0, ed->getWidth(), ed->getHeight());
  // Let the timer-driven state (waveform, status, visibility) settle first.
  for (int i = 0; i < 30; ++i) {
    juce::MessageManager::getInstance()->runDispatchLoopUntil(20);
  }
  const auto img = ed->createComponentSnapshot(ed->getLocalBounds(), true, 2.0f);
  const auto out = juce::File::getCurrentWorkingDirectory().getChildFile(name);
  out.deleteFile();
  juce::PNGImageFormat png;
  std::unique_ptr<juce::FileOutputStream> os(out.createOutputStream());
  if (os != nullptr && png.writeImageToStream(img, *os)) {
    printf("wrote %s  %dx%d\n", out.getFullPathName().toRawUTF8(), img.getWidth(), img.getHeight());
  } else {
    printf("failed to write %s\n", name);
  }
}

int main() {
  juce::ScopedJuceInitialiser_GUI juceInit;
  const auto wav = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("hazen_snap.wav");
  writeTestWav(wav);

  HazenSamplerProcessor p;
  p.setPlayConfigDetails(0, 2, 44100.0, 512);
  p.prepareToPlay(44100.0, 512);
  p.loadSample(wav);
  for (int i = 0; i < 200 && (p.isRendering() || p.renderedSeconds() <= 0.0); ++i)
    juce::Thread::sleep(25);

  shoot(p, "editor-mangle.png");

  if (auto* mode = p.params.getParameter("mode")) {
    mode->beginChangeGesture();
    mode->setValueNotifyingHost(1.0f);
    mode->endChangeGesture();
  }
  p.invalidate();
  for (int i = 0; i < 300 && p.isRendering(); ++i) juce::Thread::sleep(25);
  juce::Thread::sleep(400);
  shoot(p, "editor-chop.png");
  return 0;
}
