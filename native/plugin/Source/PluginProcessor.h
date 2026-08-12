// NEVER COMPILED. See ../../README.md.
//
// Sampler-shaped: a sample is loaded, the chain is rendered offline into a
// buffer whenever a parameter changes, and MIDI triggers play that buffer.
// Keeping the effects offline is what lets the plugin and the web tool produce
// identical audio, which is the whole reason the DSP core is shared.

#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "hazen/dsp.hpp"

class HazenManglerProcessor : public juce::AudioProcessor {
 public:
  HazenManglerProcessor();
  ~HazenManglerProcessor() override = default;

  void prepareToPlay(double sampleRate, int samplesPerBlock) override;
  void releaseResources() override {}
  bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
  void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

  juce::AudioProcessorEditor* createEditor() override;
  bool hasEditor() const override { return true; }

  const juce::String getName() const override { return "HAZEN sample mangler"; }
  bool acceptsMidi() const override { return true; }
  bool producesMidi() const override { return false; }
  double getTailLengthSeconds() const override { return 0.0; }

  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return {}; }
  void changeProgramName(int, const juce::String&) override {}

  void getStateInformation(juce::MemoryBlock&) override;
  void setStateInformation(const void*, int) override;

  /// Load a sample from disk and render the chain over it.
  bool loadSample(const juce::File& file);

  juce::AudioProcessorValueTreeState params;

 private:
  static juce::AudioProcessorValueTreeState::ParameterLayout layout();

  /// Re-render `source_` through the chain into `rendered_`.
  ///
  /// Runs off the audio thread. The audio thread only ever reads `rendered_`
  /// through `ready_`, so a render in progress never tears playback.
  void rebuild();

  juce::AudioBuffer<float> source_;
  juce::AudioBuffer<float> rendered_;
  std::atomic<bool> ready_{false};

  double sampleRate_ = 44100.0;
  /// -1 when idle, otherwise the read position in `rendered_`.
  int playhead_ = -1;

  hazen::Decimator decimateL_, decimateR_;
  hazen::Reverb reverbL_, reverbR_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HazenManglerProcessor)
};
