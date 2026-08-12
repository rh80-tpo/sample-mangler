#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>

#include "hazen/chop.hpp"

/**
 * HAZEN Sampler.
 *
 * A sampler, not a port of the web build's live graph — deliberately. The web
 * tool renders the whole chain offline once and plays the result, which is what
 * makes its preview and its export identical. A plugin that streamed the chain
 * per block would produce different audio from the same settings, so this keeps
 * the same shape: load a file, render it offline on a background thread, play
 * the rendered buffer.
 *
 * That also means every parameter change queues a re-render rather than taking
 * effect on the next sample. Renders are fast, but they are not instant, and the
 * editor says when one is in flight.
 */
class HazenSamplerProcessor : public juce::AudioProcessor,
                              private juce::Thread {
 public:
  HazenSamplerProcessor();
  ~HazenSamplerProcessor() override;

  void prepareToPlay(double sampleRate, int samplesPerBlock) override;
  void releaseResources() override;
  bool isBusesLayoutSupported(const BusesLayout&) const override;
  void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

  juce::AudioProcessorEditor* createEditor() override;
  bool hasEditor() const override { return true; }

  const juce::String getName() const override { return "HAZEN Sampler"; }
  bool acceptsMidi() const override { return true; }
  bool producesMidi() const override { return false; }
  bool isMidiEffect() const override { return false; }
  double getTailLengthSeconds() const override { return 0.0; }

  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return "default"; }
  void changeProgramName(int, const juce::String&) override {}

  void getStateInformation(juce::MemoryBlock&) override;
  void setStateInformation(const void*, int) override;

  /// Load a sample. Safe to call from the message thread; kicks a re-render.
  bool loadSample(const juce::File& file);

  juce::AudioProcessorValueTreeState params;

  // --- editor-facing state ---------------------------------------------
  juce::String sampleName() const;
  bool hasSample() const;
  bool isRendering() const { return rendering.load(); }
  double renderedSeconds() const;
  /// A copy of the rendered peaks for drawing, or empty if there is nothing yet.
  std::vector<float> peaks(int columns) const;
  /// Per-column rms, parallel to peaks(). Drawn as a brighter core inside the
  /// envelope so loud-and-dense reads differently from loud-and-spiky, which is
  /// most of what a waveform is for.
  std::vector<float> rms(int columns) const;
  /// 0 to 1 through the rendered buffer, or -1 when idle.
  float playPosition() const;
  juce::String status() const;

  /// Ask for a re-render. Coalesced: many calls collapse into one pass.
  void invalidate();

  /// Roll a random chain, the way the web build's reroll does.
  void reroll();
  /// A fresh chop from the same settings. The rhythm is seeded, so without this
  /// every chop of a given setup was byte-identical and there was no way to ask
  /// for another one.
  void rechop();
  /// Rechop and roll a random rack over it in one press.
  void chopAndMangle();
  /// True when any rack module is switched on.
  bool rackActive() const;
  /// Step through past rolls. -1 back, +1 forward. Returns false at the ends.
  bool stepRoll(int delta);
  int rollIndex() const { return static_cast<int>(rollAt); }
  int rollCount() const { return static_cast<int>(rolls.size()); }

  /// Chop voice starts as fractions of the buffer, for drawing boundaries.
  std::vector<float> voiceStarts() const;
  /// Which source slice each voice came from, parallel to voiceStarts().
  std::vector<int> voiceSlices() const;
  /// The grid in use: the host's tempo when synced, the tempo knob otherwise.
  double tempo() const { return hostBpm; }

 private:
  void run() override;  // the render thread
  void renderNow();
  void readParameters();

  static juce::AudioProcessorValueTreeState::ParameterLayout layout();

  juce::AudioFormatManager formats;

  // Guards `source` and `rendered`, both of which the audio thread reads.
  mutable juce::CriticalSection audioLock;
  hazen::Audio source;   ///< the loaded file, untouched
  hazen::Audio rendered; ///< what actually plays
  std::vector<hazen::Voice> voices; ///< chop boundaries, for the editor
  juce::String loadedName;
  juce::String statusText{"drop a sample"};

  std::atomic<bool> rendering{false};
  std::atomic<bool> dirty{false};

  /// Past rolls, as parameter snapshots. Tiny next to keeping the audio.
  std::vector<juce::ValueTree> rolls;
  std::size_t rollAt = 0;
  juce::Random dice;
  /// Feeds both the chop's rhythm and the rack's chop. Changing it is what makes
  /// a rechop different from the last one.
  std::uint32_t rollSeed = 1;

  // Settings snapshot, read on the message thread, used by the render thread.
  hazen::MangleSettings mangle;
  hazen::ChopSettings chopping;
  int modeIndex = 0;   ///< 0 mangle, 1 chop
  double barsWanted = 2.0;
  float duckAmount = 0.0f;
  int duckRate = 4;
  float duckRelease = 0.45f;
  float levelDb = 0.0f;
  double hostBpm = 120.0;

  // --- playback --------------------------------------------------------
  // A voice is just a position in the rendered buffer. One at a time: this is a
  // loop player, and two copies of the same loop overlapping is never what you
  // want.
  std::atomic<bool> playing{false};
  double playHead = 0.0;
  bool syncToHost = false;
  double lastHostPpq = -1.0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HazenSamplerProcessor)
};
