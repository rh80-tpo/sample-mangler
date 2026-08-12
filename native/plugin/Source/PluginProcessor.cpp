#include "PluginProcessor.h"

#include "PluginEditor.h"

namespace {
constexpr const char* kModes[] = {"mangle", "chop"};
constexpr const char* kPatterns[] = {"AAAB", "ABAB", "AABA", "ABAC", "AAAA", "ABCB"};
constexpr const char* kCuts[] = {"transients", "1/1", "1/2", "1/4", "1/8", "1/16"};
constexpr const char* kRates[] = {"1/1", "1/2", "1/4", "1/8"};
constexpr const char* kBars[] = {"1", "2", "4", "8", "16"};
constexpr const char* kLengths[] = {"4 bars", "8 bars", "16 bars"};

int cutPerBar(int index) {
  static constexpr int v[] = {0, 1, 2, 4, 8, 16};
  return v[juce::jlimit(0, 5, index)];
}
int ratePerBar(int index) {
  static constexpr int v[] = {1, 2, 4, 8};
  return v[juce::jlimit(0, 3, index)];
}
double barsFor(int index) {
  static constexpr double v[] = {1.0, 2.0, 4.0, 8.0, 16.0};
  return v[juce::jlimit(0, 4, index)];
}
int phraseBarsFor(int index) {
  static constexpr int v[] = {1, 2, 4};
  return v[juce::jlimit(0, 2, index)];
}
}  // namespace

juce::AudioProcessorValueTreeState::ParameterLayout HazenSamplerProcessor::layout() {
  using namespace juce;
  AudioProcessorValueTreeState::ParameterLayout p;
  auto pct = [](const String& id, const String& name, float def) {
    return std::make_unique<AudioParameterFloat>(ParameterID{id, 1}, name,
                                                 NormalisableRange<float>{0.0f, 1.0f}, def);
  };

  p.add(std::make_unique<AudioParameterChoice>(ParameterID{"mode", 1}, "Mode",
                                               StringArray{kModes, 2}, 0));
  p.add(std::make_unique<AudioParameterBool>(ParameterID{"sync", 1}, "Sync to host", true));

  // --- mangle ---
  p.add(std::make_unique<AudioParameterBool>(ParameterID{"revon", 1}, "Reverse", false));
  p.add(std::make_unique<AudioParameterBool>(ParameterID{"chopon", 1}, "Chop", false));
  p.add(std::make_unique<AudioParameterInt>(ParameterID{"segments", 1}, "Slices", 2, 64, 12));
  p.add(pct("scatter", "Scatter", 0.4f));
  p.add(pct("stutter", "Stutter", 0.3f));
  p.add(pct("gate", "Gate", 0.1f));
  p.add(std::make_unique<AudioParameterBool>(ParameterID{"crushon", 1}, "Bitcrush", false));
  p.add(std::make_unique<AudioParameterInt>(ParameterID{"bits", 1}, "Bits", 1, 16, 8));
  p.add(std::make_unique<AudioParameterInt>(ParameterID{"divisor", 1}, "Rate", 1, 32, 4));
  p.add(std::make_unique<AudioParameterBool>(ParameterID{"pitchon", 1}, "Pitch", false));
  p.add(std::make_unique<AudioParameterFloat>(ParameterID{"semitones", 1}, "Semitones",
                                              NormalisableRange<float>{-24.0f, 24.0f, 0.5f}, 0.0f));
  p.add(std::make_unique<AudioParameterFloat>(ParameterID{"grain", 1}, "Grain",
                                              NormalisableRange<float>{0.01f, 0.25f, 0.005f}, 0.06f));
  p.add(std::make_unique<AudioParameterBool>(ParameterID{"driveon", 1}, "Drive", false));
  p.add(pct("drive", "Drive amount", 0.4f));
  p.add(std::make_unique<AudioParameterBool>(ParameterID{"verbon", 1}, "Reverb", false));
  p.add(pct("verbsize", "Reverb size", 0.6f));
  p.add(pct("verbmix", "Reverb mix", 0.4f));
  p.add(std::make_unique<AudioParameterChoice>(ParameterID{"bars", 1}, "Bars",
                                               StringArray{kBars, 5}, 1));

  // --- chop ---
  p.add(std::make_unique<AudioParameterChoice>(ParameterID{"pattern", 1}, "Pattern",
                                               StringArray{kPatterns, 6}, 0));
  p.add(std::make_unique<AudioParameterChoice>(ParameterID{"length", 1}, "Length",
                                               StringArray{kLengths, 3}, 2));
  p.add(std::make_unique<AudioParameterChoice>(ParameterID{"cut", 1}, "Cut",
                                               StringArray{kCuts, 6}, 0));
  p.add(pct("density", "Density", 0.55f));
  p.add(pct("variation", "Variation", 0.6f));
  p.add(pct("hold", "Hold", 0.25f));
  p.add(std::make_unique<AudioParameterChoice>(ParameterID{"res", 1}, "Grid",
                                               StringArray{"1/8", "1/16"}, 1));

  // --- out ---
  p.add(pct("duck", "Duck", 0.0f));
  p.add(pct("duckrel", "Duck release", 0.45f));
  p.add(std::make_unique<AudioParameterChoice>(ParameterID{"duckrate", 1}, "Kick rate",
                                               StringArray{kRates, 4}, 2));
  p.add(std::make_unique<AudioParameterFloat>(ParameterID{"level", 1}, "Level",
                                              NormalisableRange<float>{-48.0f, 0.0f, 0.5f}, 0.0f));
  return p;
}

HazenSamplerProcessor::HazenSamplerProcessor()
    : AudioProcessor(BusesProperties().withOutput("Out", juce::AudioChannelSet::stereo(), true)),
      Thread("hazen-render"),
      params(*this, nullptr, "HAZEN", layout()) {
  formats.registerBasicFormats();
  startThread(juce::Thread::Priority::low);
}

HazenSamplerProcessor::~HazenSamplerProcessor() {
  signalThreadShouldExit();
  notify();
  stopThread(2000);
}

void HazenSamplerProcessor::prepareToPlay(double, int) {}
void HazenSamplerProcessor::releaseResources() {}

bool HazenSamplerProcessor::isBusesLayoutSupported(const BusesLayout& l) const {
  const auto out = l.getMainOutputChannelSet();
  return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

bool HazenSamplerProcessor::loadSample(const juce::File& file) {
  std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
  if (reader == nullptr) {
    const juce::ScopedLock sl(audioLock);
    statusText = "could not read " + file.getFileName();
    return false;
  }
  const auto frames = static_cast<int>(reader->lengthInSamples);
  if (frames <= 0) {
    const juce::ScopedLock sl(audioLock);
    statusText = file.getFileName() + " is empty";
    return false;
  }
  // A whole track would make every render slow for no benefit, so take the
  // first 30 seconds and say so rather than silently truncating.
  const int maxFrames = static_cast<int>(reader->sampleRate * 30.0);
  const int wanted = juce::jmin(frames, maxFrames);

  juce::AudioBuffer<float> tmp(static_cast<int>(reader->numChannels), wanted);
  reader->read(&tmp, 0, wanted, 0, true, true);

  hazen::Audio loaded;
  loaded.sample_rate = reader->sampleRate;
  loaded.resize(tmp.getNumChannels(), static_cast<std::size_t>(wanted));
  for (int c = 0; c < tmp.getNumChannels(); ++c) {
    const float* src = tmp.getReadPointer(c);
    std::copy(src, src + wanted, loaded.channels[static_cast<std::size_t>(c)].begin());
  }

  {
    const juce::ScopedLock sl(audioLock);
    source = std::move(loaded);
    loadedName = file.getFileName();
    statusText = frames > maxFrames ? loadedName + " (first 30s)" : loadedName;
  }
  invalidate();
  return true;
}

void HazenSamplerProcessor::invalidate() {
  dirty.store(true);
  notify();
}

void HazenSamplerProcessor::readParameters() {
  auto raw = [this](const char* id) { return params.getRawParameterValue(id)->load(); };
  auto flag = [&](const char* id) { return raw(id) > 0.5f; };

  modeIndex = static_cast<int>(raw("mode"));
  syncToHost = flag("sync");

  mangle.reverse_on = flag("revon");
  mangle.chop_on = flag("chopon");
  mangle.segments = static_cast<int>(raw("segments"));
  mangle.scatter = raw("scatter");
  mangle.stutter = raw("stutter");
  mangle.gate = raw("gate");
  mangle.crush_on = flag("crushon");
  mangle.bits = static_cast<int>(raw("bits"));
  mangle.divisor = static_cast<int>(raw("divisor"));
  mangle.pitch_on = flag("pitchon");
  mangle.semitones = raw("semitones");
  mangle.window = raw("grain");
  mangle.drive_on = flag("driveon");
  mangle.drive = raw("drive");
  mangle.verb_on = flag("verbon");
  mangle.verb_size = raw("verbsize");
  mangle.verb_mix = raw("verbmix");
  mangle.seed = 1;
  barsWanted = barsFor(static_cast<int>(raw("bars")));

  chopping.bpm = hostBpm;
  chopping.pattern = static_cast<hazen::Pattern>(juce::jlimit(0, 5, static_cast<int>(raw("pattern"))));
  chopping.phrase_bars = phraseBarsFor(static_cast<int>(raw("length")));
  chopping.cut_per_bar = cutPerBar(static_cast<int>(raw("cut")));
  chopping.density = raw("density");
  chopping.variation = raw("variation");
  chopping.hold = raw("hold");
  chopping.resolution = static_cast<int>(raw("res")) == 0 ? 8 : 16;
  chopping.seed = 1;

  duckAmount = raw("duck");
  duckRelease = raw("duckrel");
  duckRate = ratePerBar(static_cast<int>(raw("duckrate")));
  levelDb = raw("level");
}

void HazenSamplerProcessor::run() {
  while (!threadShouldExit()) {
    if (dirty.exchange(false)) {
      renderNow();
    } else {
      wait(80);
    }
  }
}

void HazenSamplerProcessor::renderNow() {
  hazen::Audio input;
  {
    const juce::ScopedLock sl(audioLock);
    if (source.frames() == 0) return;
    input = source;  // copy, so the audio thread never sees a half-written buffer
  }

  rendering.store(true);
  readParameters();

  hazen::Audio out;
  juce::String note;
  if (modeIndex == 1) {
    const auto chopped = hazen::build_chop(input, chopping);
    out = chopped.audio;
    note = juce::String(chopped.bars) + " bars · " + juce::String(chopped.slice_count) +
           (chopping.cut_per_bar > 0 ? " slices on a grid" : " slices from transients");
  } else {
    out = input;
    hazen::run_mangle(out, mangle);
    hazen::fit_to_bars(out, barsWanted, hostBpm);
    note = juce::String(barsWanted, 0) + " bars · mangled";
  }

  hazen::apply_sidechain(out, duckAmount, duckRate, duckRelease, hostBpm);
  hazen::apply_level(out, levelDb);

  {
    const juce::ScopedLock sl(audioLock);
    rendered = std::move(out);
    statusText = loadedName.isEmpty() ? note : loadedName + " · " + note;
  }
  rendering.store(false);
}

void HazenSamplerProcessor::processBlock(juce::AudioBuffer<float>& buffer,
                                         juce::MidiBuffer& midi) {
  juce::ScopedNoDenormals guard;
  buffer.clear();

  // Follow the host's tempo. A chop built at the wrong tempo is useless, and a
  // sampler in a DAW has no business inventing its own clock.
  if (auto* head = getPlayHead()) {
    if (const auto pos = head->getPosition()) {
      if (const auto bpm = pos->getBpm()) {
        if (std::abs(*bpm - hostBpm) > 0.01) {
          hostBpm = *bpm;
          invalidate();
        }
      }
      if (syncToHost) {
        if (const auto ppq = pos->getPpqPosition()) {
          // Restart on the bar so the loop stays locked to the arrangement
          // rather than to whenever the plugin happened to be told to play.
          const double bars = *ppq / 4.0;
          const double wrapped = bars - std::floor(bars);
          const bool rolling = pos->getIsPlaying();
          if (rolling) {
            if (lastHostPpq < 0.0 || wrapped < lastHostPpq) playHead = 0.0;
            lastHostPpq = wrapped;
            playing.store(true);
          } else {
            playing.store(false);
            lastHostPpq = -1.0;
          }
        }
      }
    }
  }

  for (const auto meta : midi) {
    const auto m = meta.getMessage();
    if (m.isNoteOn()) {
      playHead = 0.0;
      playing.store(true);
    } else if (m.isNoteOff() || m.isAllNotesOff()) {
      // Notes retrigger rather than gate: a chop loop should finish its bar.
      if (m.isAllNotesOff()) playing.store(false);
    }
  }

  const juce::ScopedTryLock sl(audioLock);
  if (!sl.isLocked() || rendered.frames() == 0 || !playing.load()) return;

  const auto frames = rendered.frames();
  const int outChans = buffer.getNumChannels();
  const int n = buffer.getNumSamples();
  // The rendered buffer is at the file's rate; step through it at the ratio to
  // the host rate so a 48k sample in a 44.1k session plays at the right pitch.
  const double ratio = rendered.sample_rate / getSampleRate();

  for (int i = 0; i < n; ++i) {
    if (playHead >= static_cast<double>(frames)) {
      playHead = 0.0;  // loop
    }
    const auto i0 = static_cast<std::size_t>(playHead);
    const auto i1 = std::min(frames - 1, i0 + 1);
    const float frac = static_cast<float>(playHead - static_cast<double>(i0));
    for (int c = 0; c < outChans; ++c) {
      const auto& src = rendered.channels[static_cast<std::size_t>(
          std::min(c, rendered.channel_count() - 1))];
      buffer.getWritePointer(c)[i] = src[i0] * (1.0f - frac) + src[i1] * frac;
    }
    playHead += ratio;
  }
}

juce::String HazenSamplerProcessor::sampleName() const {
  const juce::ScopedLock sl(audioLock);
  return loadedName;
}

bool HazenSamplerProcessor::hasSample() const {
  const juce::ScopedLock sl(audioLock);
  return source.frames() > 0;
}

double HazenSamplerProcessor::renderedSeconds() const {
  const juce::ScopedLock sl(audioLock);
  return rendered.seconds();
}

juce::String HazenSamplerProcessor::status() const {
  const juce::ScopedLock sl(audioLock);
  return statusText;
}

float HazenSamplerProcessor::playPosition() const {
  if (!playing.load()) return -1.0f;
  const juce::ScopedLock sl(audioLock);
  if (rendered.frames() == 0) return -1.0f;
  return static_cast<float>(playHead / static_cast<double>(rendered.frames()));
}

std::vector<float> HazenSamplerProcessor::peaks(int columns) const {
  std::vector<float> out;
  const juce::ScopedLock sl(audioLock);
  if (rendered.frames() == 0 || columns <= 0) return out;
  out.resize(static_cast<std::size_t>(columns), 0.0f);
  const auto per = std::max<std::size_t>(1, rendered.frames() / static_cast<std::size_t>(columns));
  for (int i = 0; i < columns; ++i) {
    const std::size_t at = static_cast<std::size_t>(i) * per;
    float peak = 0.0f;
    for (const auto& ch : rendered.channels) {
      for (std::size_t j = at; j < std::min(rendered.frames(), at + per); ++j) {
        peak = std::max(peak, std::fabs(ch[j]));
      }
    }
    out[static_cast<std::size_t>(i)] = peak;
  }
  return out;
}

void HazenSamplerProcessor::getStateInformation(juce::MemoryBlock& dest) {
  auto state = params.copyState();
  // The sample path travels with the session. The audio itself does not: a
  // preset that embedded 30 seconds of PCM would bloat every save, and the file
  // is on disk anyway.
  state.setProperty("samplePath", sampleName(), nullptr);
  if (auto xml = state.createXml()) copyXmlToBinary(*xml, dest);
}

void HazenSamplerProcessor::setStateInformation(const void* data, int size) {
  if (auto xml = getXmlFromBinary(data, size)) {
    params.replaceState(juce::ValueTree::fromXml(*xml));
    invalidate();
  }
}

juce::AudioProcessorEditor* HazenSamplerProcessor::createEditor() {
  return new HazenSamplerEditor(*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
  return new HazenSamplerProcessor();
}
