#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>

#include <array>
#include <atomic>

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
  /// Peaks for drawing, resampled from a snapshot the render thread published.
  /// Never touches anything the audio thread reads.
  std::vector<float> peaks(int columns) const;
  /// Per-column rms, parallel to peaks(). Drawn as a brighter core inside the
  /// envelope so loud-and-dense reads differently from loud-and-spiky.
  std::vector<float> rms(int columns) const;
  /// 0 to 1 through the rendered buffer, or -1 when idle.
  float playPosition() const;
  juce::String status() const;

  /// Ask for a re-render. Coalesced: many calls collapse into one pass.
  void invalidate();

  // --- transport -------------------------------------------------------
  /// Play from the top. Independent of the host transport, so it still works
  /// with sync on and the host stopped.
  void startPlayback();
  void stopPlayback();
  bool isPlaying() const { return playing.load(); }

  /// Write the rendered loop as a 24-bit WAV. Returns false if there is nothing
  /// to write or the file could not be opened.
  bool exportTo(const juce::File& file) const;
  /// A WAV of the current loop in the temp folder, for dragging into a host.
  /// Empty file on failure.
  juce::File writeDragFile() const;
  /// A name worth giving an exported file: the source plus what was done to it.
  juce::String exportName() const;

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
  double tempo() const { return hostBpm.load(); }

 private:
  void run() override;  // the render thread
  void renderNow();
  void readParameters();
  void publishForEditor(const hazen::Audio&, const std::vector<hazen::Voice>&,
                        const juce::String& note);

  static juce::AudioProcessorValueTreeState::ParameterLayout layout();

  juce::AudioFormatManager formats;

  // --- threading -------------------------------------------------------
  //
  // The audio thread does not lock. It used to take a try-lock on the same
  // mutex the editor's 20Hz timer took for peaks, waveform and status, and when
  // the timer held it processBlock bailed out and emitted a whole block of
  // silence. Measured under normal editor load: 20.7% of blocks dropped. That is
  // the clicking, and a bigger buffer made it worse rather than better, because
  // a dropped block is a longer hole.
  //
  // So: finished takes are published into one of three slots and pointed at by
  // an atomic index. Three, not two, so the render thread can never overwrite
  // the slot the audio thread is reading or the one it is crossfading out of.
  struct Take {
    hazen::Audio audio;
    std::vector<hazen::Voice> voices;
  };
  std::array<Take, 3> takes;
  std::atomic<int> liveTake{-1};
  int writeTake = 0;

  /// Guards the source only. The audio thread never reads it.
  mutable juce::CriticalSection sourceLock;
  hazen::Audio source;
  juce::String loadedName;

  /// What the editor draws, published by the render thread. Its own lock, so
  /// the UI can never stall the audio thread.
  struct Snapshot {
    std::vector<float> peaks;
    std::vector<float> rms;
    std::vector<float> voiceAt;
    std::vector<int> voiceSlice;
    juce::String status{"drop a sample"};
    double seconds = 0.0;
    bool hasSample = false;
  };
  static constexpr int kSnapshotColumns = 1024;
  mutable juce::CriticalSection uiLock;
  Snapshot ui;

  std::atomic<bool> rendering{false};
  std::atomic<bool> dirty{false};
  std::atomic<float> position{-1.0f};

  /// Past rolls, as parameter snapshots. Tiny next to keeping the audio.
  std::vector<juce::ValueTree> rolls;
  std::size_t rollAt = 0;
  juce::Random dice;
  std::uint32_t rollSeed = 1;

  // Settings snapshot, read on the render thread.
  hazen::MangleSettings mangle;
  hazen::ChopSettings chopping;
  int modeIndex = 0;
  double barsWanted = 2.0;
  float duckAmount = 0.0f;
  int duckRate = 4;
  float duckRelease = 0.45f;
  float levelDb = 0.0f;
  std::atomic<double> hostBpm{120.0};

  // --- playback --------------------------------------------------------
  std::atomic<bool> playing{false};
  std::atomic<bool> manualPlay{false};
  std::atomic<bool> restartPending{false};
  /// Asks the audio thread to jump to the top. Set by play and by the actions
  /// that mean "this is a new idea".
  std::atomic<bool> rewind{false};

  // Audio-thread only below this line.
  double playHead = 0.0;
  int readingTake = -1;
  /// Crossfade between takes, so swapping the buffer under a playing loop is a
  /// blend rather than a step.
  int fadeFrom = -1;
  double fadeFromHead = 0.0;
  int fadePos = 0;
  int fadeLength = 0;
  /// Transport ramp. A hard start or stop is a step to or from full amplitude,
  /// which is a click by definition.
  float gain = 0.0f;
  float gainStep = 0.0f;

  bool syncToHost = false;
  double lastHostPpq = -1.0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HazenSamplerProcessor)
};
