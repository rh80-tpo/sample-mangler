#include "PluginProcessor.h"

#include "PluginEditor.h"

namespace {
/// Bytes, not a source literal: the encoding of this file is not something to
/// bet the status line on.
const juce::String kDot = juce::String::fromUTF8(" \xc2\xb7 ");

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
/// Nearest-neighbour resample of a snapshot column array to the panel width.
std::vector<float> resample(const std::vector<float>& from, int columns) {
  std::vector<float> out;
  if (from.empty() || columns <= 0) return out;
  out.resize(static_cast<std::size_t>(columns));
  for (int i = 0; i < columns; ++i) {
    const auto at = static_cast<std::size_t>(double(i) / columns * double(from.size()));
    out[static_cast<std::size_t>(i)] = from[std::min(from.size() - 1, at)];
  }
  return out;
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
  // Adjustable, defaulting to 120. Used whenever sync is off; with sync on the
  // host's tempo wins, because a sampler in a DAW has no business inventing its
  // own clock.
  p.add(std::make_unique<AudioParameterFloat>(ParameterID{"tempo", 1}, "Tempo",
                                              NormalisableRange<float>{40.0f, 220.0f, 1.0f}, 120.0f));

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
  p.add(std::make_unique<AudioParameterFloat>(
      ParameterID{"verbdamp", 1}, "Reverb damp",
      NormalisableRange<float>{200.0f, 18000.0f, 50.0f, 0.42f}, 4000.0f));
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
    // Say which kind of failure it is. A video that opens but has no audio
    // track is a different problem from a corrupt wav, and "could not read"
    // sends you looking in the wrong place for both.
    static const char* kVideo[] = {"mp4", "mov", "m4v", "mkv", "avi", "webm", "wmv", "3gp"};
    bool video = false;
    for (const auto* ext : kVideo) video = video || file.hasFileExtension(ext);
    const juce::ScopedLock sl(uiLock);
    ui.status = video ? file.getFileName() + ": no audio track this can read"
                      : "could not read " + file.getFileName();
    return false;
  }
  if (reader->numChannels == 0) {
    const juce::ScopedLock sl(uiLock);
    ui.status = file.getFileName() + ": no audio track";
    return false;
  }
  const auto frames = static_cast<int>(reader->lengthInSamples);
  if (frames <= 0) {
    const juce::ScopedLock sl(uiLock);
    ui.status = file.getFileName() + " is empty";
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
    const juce::ScopedLock sl(sourceLock);
    source = std::move(loaded);
    loadedName = file.getFileName();
  }
  {
    const juce::ScopedLock sl(uiLock);
    ui.status = frames > maxFrames ? file.getFileName() + " (first 30s)" : file.getFileName();
    ui.hasSample = true;
  }
  restartPending.store(true);
  invalidate();
  return true;
}

void HazenSamplerProcessor::startPlayback() {
  // Atomics only. Touching playHead from here would need the audio lock, which
  // is the thing that caused the dropouts in the first place — the audio thread
  // rewinds itself when it sees the flag.
  rewind.store(true);
  manualPlay.store(true);
  playing.store(true);
}

void HazenSamplerProcessor::stopPlayback() {
  manualPlay.store(false);
  playing.store(false);
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
  // With sync off the knob is the grid. With it on, processBlock has already
  // pushed the host's tempo into hostBpm.
  if (!syncToHost) hostBpm.store(static_cast<double>(raw("tempo")));

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
  mangle.verb_damp = raw("verbdamp");
  mangle.verb_mix = raw("verbmix");
  mangle.seed = rollSeed;
  barsWanted = barsFor(static_cast<int>(raw("bars")));

  chopping.bpm = hostBpm.load();
  chopping.pattern = static_cast<hazen::Pattern>(juce::jlimit(0, 5, static_cast<int>(raw("pattern"))));
  chopping.phrase_bars = phraseBarsFor(static_cast<int>(raw("length")));
  chopping.cut_per_bar = cutPerBar(static_cast<int>(raw("cut")));
  chopping.density = raw("density");
  chopping.variation = raw("variation");
  chopping.hold = raw("hold");
  chopping.resolution = static_cast<int>(raw("res")) == 0 ? 8 : 16;
  chopping.seed = rollSeed;

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
  juce::String name;
  {
    const juce::ScopedLock sl(sourceLock);
    if (source.frames() == 0) return;
    input = source;
    name = loadedName;
  }

  rendering.store(true);
  readParameters();

  hazen::Audio out;
  juce::String note;
  std::vector<hazen::Voice> builtVoices;
  if (modeIndex == 1) {
    const auto chopped = hazen::build_chop(input, chopping);
    out = chopped.audio;
    builtVoices = chopped.voices;
    note = juce::String(chopped.bars) + " bars" + kDot + juce::String(chopped.slice_count) +
           (chopping.cut_per_bar > 0 ? " slices on a grid" : " slices from transients");
    // The rack runs over the finished loop, the way it does on the site. It was
    // skipped entirely here, so every module was dead in chop mode. No bar
    // fitting afterwards: the chop is already exact, and a reverb tail is meant
    // to ring past the loop rather than be trimmed back into it.
    if (rackActive()) {
      // Per phrase, then restitched. Running the rack over the whole loop
      // reordered and smeared material across phrase boundaries and destroyed
      // the arrangement the pattern exists to create.
      const auto frames = chopped.phrases[static_cast<std::size_t>(chopped.order[0])].frames();
      auto treated = chopped.phrases;
      for (auto& phrase : treated) {
        if (phrase.frames() == 0) continue;
        hazen::run_mangle(phrase, mangle);
      }
      out = hazen::stitch_phrases(treated, chopped.order, frames);
      note += kDot + juce::String("racked");
    }
  } else {
    out = input;
    hazen::run_mangle(out, mangle);
    hazen::fit_to_bars(out, barsWanted, hostBpm.load());
    note = juce::String(barsWanted, 0) + juce::String(" bars") + kDot + "mangled";
  }

  hazen::apply_sidechain(out, duckAmount, duckRate, duckRelease, hostBpm.load());
  hazen::apply_level(out, levelDb);

  publishForEditor(out, builtVoices, name.isEmpty() ? note : name + kDot + note);

  // Publish into the slot the audio thread is not reading, then point at it.
  // The release/acquire pair is what makes the buffer visible before the index.
  const int slot = writeTake;
  takes[static_cast<std::size_t>(slot)].audio = std::move(out);
  takes[static_cast<std::size_t>(slot)].voices = std::move(builtVoices);
  writeTake = (writeTake + 1) % static_cast<int>(takes.size());
  liveTake.store(slot, std::memory_order_release);

  // A rechop or a roll is a new idea, so it is heard from the top rather than
  // from wherever the last one happened to be.
  if (restartPending.exchange(false)) rewind.store(true);
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
        if (std::abs(*bpm - hostBpm.load()) > 0.01) {
          hostBpm.store(*bpm);
          dirty.store(true);  // notify() is not real-time safe; the thread polls
        }
      }
      if (syncToHost) {
        if (const auto ppq = pos->getPpqPosition()) {
          const double bars = *ppq / 4.0;
          const double wrapped = bars - std::floor(bars);
          if (pos->getIsPlaying()) {
            // Restart on the bar so the loop stays locked to the arrangement.
            if (lastHostPpq < 0.0 || wrapped < lastHostPpq) rewind.store(true);
            lastHostPpq = wrapped;
            playing.store(true);
          } else {
            playing.store(manualPlay.load());
            lastHostPpq = -1.0;
          }
        }
      }
    }
  }

  for (const auto meta : midi) {
    const auto m = meta.getMessage();
    if (m.isNoteOn()) {
      rewind.store(true);
      playing.store(true);
    } else if (m.isAllNotesOff()) {
      playing.store(false);
    }
  }

  // No lock. The index is the only shared thing read here, and the buffer it
  // points at is never written while it is live.
  const int want = liveTake.load(std::memory_order_acquire);
  if (want < 0) {
    position.store(-1.0f, std::memory_order_relaxed);
    return;
  }

  const double sr = getSampleRate() > 0.0 ? getSampleRate() : 44100.0;
  const int rampFrames = std::max(1, int(0.006 * sr));
  const bool wantPlaying = playing.load();

  if (want != readingTake) {
    // Swapping the buffer under a playing loop is a step unless it is blended.
    if (readingTake >= 0 && gain > 0.0f) {
      fadeFrom = readingTake;
      fadeFromHead = playHead;
      fadePos = 0;
      fadeLength = std::max(1, int(0.008 * sr));
    }
    readingTake = want;
    const auto frames = takes[static_cast<std::size_t>(want)].audio.frames();
    if (frames == 0 || playHead >= double(frames)) playHead = 0.0;
  }

  if (rewind.exchange(false)) {
    playHead = 0.0;
    // Cancel any crossfade: a rewind is meant to be heard from the top, not
    // blended with where it used to be.
    fadeFrom = -1;
  }

  const auto& take = takes[static_cast<std::size_t>(readingTake)];
  const auto frames = take.audio.frames();
  if (frames == 0) {
    position.store(-1.0f, std::memory_order_relaxed);
    return;
  }

  // Ramp toward the transport state rather than jumping to it.
  const float target = wantPlaying ? 1.0f : 0.0f;
  gainStep = (target - gain) / float(rampFrames);

  const int outChans = buffer.getNumChannels();
  const int n = buffer.getNumSamples();
  const double ratio = take.audio.sample_rate / sr;

  auto sampleAt = [](const hazen::Audio& a, double head, int channel) {
    const auto len = a.frames();
    const auto i0 = static_cast<std::size_t>(head);
    const auto i1 = (i0 + 1) % len;  // wraps, so the loop point interpolates too
    const float frac = static_cast<float>(head - double(i0));
    const auto& src = a.channels[static_cast<std::size_t>(
        std::min(channel, a.channel_count() - 1))];
    return src[i0] * (1.0f - frac) + src[i1] * frac;
  };

  for (int i = 0; i < n; ++i) {
    if (gain < target) gain = std::min(target, gain + std::abs(gainStep));
    else if (gain > target) gain = std::max(target, gain - std::abs(gainStep));

    if (playHead >= double(frames)) playHead -= double(frames);  // seamless wrap

    float blend = 1.0f;
    if (fadeFrom >= 0) {
      blend = float(fadePos) / float(fadeLength);
      if (++fadePos >= fadeLength) fadeFrom = -1;
    }

    for (int c = 0; c < outChans; ++c) {
      float v = sampleAt(take.audio, playHead, c) * blend;
      if (fadeFrom >= 0) {
        const auto& old = takes[static_cast<std::size_t>(fadeFrom)].audio;
        if (old.frames() > 0) {
          const double h = std::fmod(fadeFromHead, double(old.frames()));
          v += sampleAt(old, h, c) * (1.0f - blend);
        }
      }
      buffer.getWritePointer(c)[i] = v * gain;
    }

    playHead += ratio;
    if (fadeFrom >= 0) fadeFromHead += ratio;
  }

  // Once the ramp has closed, stop consuming: a silent loop still burns cycles.
  if (!wantPlaying && gain <= 0.0f) {
    playHead = 0.0;
    position.store(-1.0f, std::memory_order_relaxed);
  } else {
    position.store(float(playHead / double(frames)), std::memory_order_relaxed);
  }
}

juce::String HazenSamplerProcessor::sampleName() const {
  const juce::ScopedLock sl(sourceLock);
  return loadedName;
}

bool HazenSamplerProcessor::hasSample() const {
  const juce::ScopedLock sl(sourceLock);
  return source.frames() > 0;
}

double HazenSamplerProcessor::renderedSeconds() const {
  const juce::ScopedLock sl(uiLock);
  return ui.seconds;
}

juce::String HazenSamplerProcessor::status() const {
  const juce::ScopedLock sl(uiLock);
  return ui.status;
}

float HazenSamplerProcessor::playPosition() const {
  // Published by the audio thread. Reading it takes no lock at all.
  return position.load(std::memory_order_relaxed);
}

std::vector<float> HazenSamplerProcessor::peaks(int columns) const {
  const juce::ScopedLock sl(uiLock);
  return resample(ui.peaks, columns);
}

void HazenSamplerProcessor::publishForEditor(const hazen::Audio& audio,
                                             const std::vector<hazen::Voice>& v,
                                             const juce::String& note) {
  Snapshot snap;
  snap.status = note;
  snap.seconds = audio.seconds();
  snap.hasSample = true;
  const auto frames = audio.frames();
  if (frames > 0) {
    // Computed once here at a fixed resolution, and the editor resamples. Doing
    // it per repaint is what put the UI on the audio lock to begin with.
    snap.peaks.resize(kSnapshotColumns, 0.0f);
    snap.rms.resize(kSnapshotColumns, 0.0f);
    const auto per = std::max<std::size_t>(1, frames / kSnapshotColumns);
    for (int i = 0; i < kSnapshotColumns; ++i) {
      const std::size_t at = static_cast<std::size_t>(i) * per;
      float peak = 0.0f;
      double sum = 0.0;
      std::size_t n = 0;
      for (const auto& ch : audio.channels) {
        for (std::size_t j = at; j < std::min(frames, at + per); ++j) {
          peak = std::max(peak, std::fabs(ch[j]));
          sum += static_cast<double>(ch[j]) * ch[j];
          ++n;
        }
      }
      snap.peaks[static_cast<std::size_t>(i)] = peak;
      snap.rms[static_cast<std::size_t>(i)] = n ? static_cast<float>(std::sqrt(sum / double(n))) : 0.0f;
    }
    snap.voiceAt.reserve(v.size());
    snap.voiceSlice.reserve(v.size());
    for (const auto& voice : v) {
      snap.voiceAt.push_back(static_cast<float>(voice.start) / static_cast<float>(frames));
      snap.voiceSlice.push_back(voice.slice);
    }
  }
  const juce::ScopedLock sl(uiLock);
  ui = std::move(snap);
}

std::vector<float> HazenSamplerProcessor::rms(int columns) const {
  const juce::ScopedLock sl(uiLock);
  return resample(ui.rms, columns);
}

juce::String HazenSamplerProcessor::exportName() const {
  const juce::ScopedLock sl(sourceLock);
  auto base = loadedName.isEmpty() ? juce::String("hazen") : loadedName.upToLastOccurrenceOf(".", false, false);
  if (base.isEmpty()) base = "hazen";
  const auto what = modeIndex == 1 ? "chop" : "mangle";
  return base + "-" + what + "-" + juce::String(juce::roundToInt(hostBpm.load())) + "bpm";
}

bool HazenSamplerProcessor::exportTo(const juce::File& file) const {
  const int slot = liveTake.load(std::memory_order_acquire);
  if (slot < 0) return false;
  const hazen::Audio copy = takes[static_cast<std::size_t>(slot)].audio;
  if (copy.frames() == 0) return false;
  file.deleteFile();
  auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
  if (stream == nullptr) return false;

  juce::WavAudioFormat wav;
  // 24 bit, matching the web build's export. It is what a sampler hands back.
  std::unique_ptr<juce::AudioFormatWriter> writer(
      wav.createWriterFor(stream.get(), copy.sample_rate,
                          static_cast<unsigned int>(copy.channel_count()), 24, {}, 0));
  if (writer == nullptr) return false;
  stream.release();  // the writer owns it now

  const int n = static_cast<int>(copy.frames());
  juce::AudioBuffer<float> buffer(copy.channel_count(), n);
  for (int c = 0; c < copy.channel_count(); ++c) {
    std::copy(copy.channels[static_cast<std::size_t>(c)].begin(),
              copy.channels[static_cast<std::size_t>(c)].end(), buffer.getWritePointer(c));
  }
  return writer->writeFromAudioSampleBuffer(buffer, 0, n);
}

juce::File HazenSamplerProcessor::writeDragFile() const {
  const auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("HAZEN Sampler");
  dir.createDirectory();
  const auto file = dir.getChildFile(exportName() + ".wav");
  return exportTo(file) ? file : juce::File{};
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

/**
 * Roll a random chain.
 *
 * Weighted the way the web build weights its pool, and with the same restraint:
 * drive and bitcrush are the two effects that flatter themselves and wreck
 * everything else, so they come up less and are capped when they land together.
 * A roll that always sounds like clipping is not a roll, it is a preset.
 */
void HazenSamplerProcessor::reroll() {
  auto set = [this](const char* id, float value) {
    if (auto* p = params.getParameter(id)) {
      p->beginChangeGesture();
      p->setValueNotifyingHost(p->convertTo0to1(value));
      p->endChangeGesture();
    }
  };
  auto chance = [this](float odds) { return dice.nextFloat() < odds; };
  auto between = [this](float lo, float hi) { return lo + dice.nextFloat() * (hi - lo); };

  const bool wantChop = chance(0.62f);
  const bool wantPitch = chance(0.58f);
  const bool wantReverse = chance(0.54f);
  const bool wantVerb = chance(0.52f);
  bool wantDrive = chance(0.24f);
  bool wantCrush = chance(0.22f);

  // Never an empty chain: an effect that does nothing is not a result.
  if (!(wantChop || wantPitch || wantReverse || wantVerb || wantDrive || wantCrush)) {
    set("chopon", 1.0f);
  }

  set("revon", wantReverse ? 1.0f : 0.0f);
  set("chopon", wantChop ? 1.0f : 0.0f);
  if (wantChop) {
    set("segments", std::round(between(4.0f, 40.0f)));
    set("scatter", between(0.1f, 0.8f));
    set("stutter", between(0.12f, 0.45f));
    set("gate", between(0.0f, 0.35f));
  }
  set("pitchon", wantPitch ? 1.0f : 0.0f);
  if (wantPitch) {
    // Whole semitones most of the time, so it stays in key more often than not.
    const float steps[] = {-12.0f, -7.0f, -5.0f, -3.0f, 3.0f, 5.0f, 7.0f, 12.0f};
    set("semitones", steps[dice.nextInt(8)]);
    set("grain", between(0.03f, 0.12f));
  }
  set("verbon", wantVerb ? 1.0f : 0.0f);
  if (wantVerb) {
    set("verbsize", between(0.3f, 0.9f));
    set("verbdamp", between(900.0f, 12000.0f));
    set("verbmix", between(0.2f, 0.6f));
  }
  set("driveon", wantDrive ? 1.0f : 0.0f);
  set("crushon", wantCrush ? 1.0f : 0.0f);
  if (wantDrive && wantCrush) {
    // Both at once is the combination that eats everything else.
    set("drive", between(0.15f, 0.45f));
    set("bits", std::round(between(8.0f, 14.0f)));
    set("divisor", std::round(between(2.0f, 8.0f)));
  } else {
    if (wantDrive) set("drive", between(0.2f, 0.7f));
    if (wantCrush) {
      set("bits", std::round(between(4.0f, 12.0f)));
      set("divisor", std::round(between(1.0f, 16.0f)));
    }
  }

  restartPending.store(true);
  // Remember it, and drop anything we had stepped past.
  if (!rolls.empty() && rollAt + 1 < rolls.size()) rolls.resize(rollAt + 1);
  rolls.push_back(params.copyState().createCopy());
  if (rolls.size() > 24) rolls.erase(rolls.begin());
  rollAt = rolls.size() - 1;
  invalidate();
}

bool HazenSamplerProcessor::rackActive() const {
  auto on = [this](const char* id) {
    return params.getRawParameterValue(id)->load() > 0.5f;
  };
  return on("revon") || on("chopon") || on("crushon") || on("pitchon") || on("driveon") ||
         on("verbon");
}

void HazenSamplerProcessor::rechop() {
  // Only the seed moves. Same tempo, same pattern, same feel — a different
  // performance of them, which is what "rechop" means on the site too.
  rollSeed = dice.nextInt({1, 1 << 30});
  restartPending.store(true);
  invalidate();
}

void HazenSamplerProcessor::chopAndMangle() {
  rollSeed = dice.nextInt({1, 1 << 30});
  // reroll() already invalidates, and it snapshots the roll for the history, so
  // the new rhythm and the new rack land together as one undoable step.
  reroll();
}

bool HazenSamplerProcessor::stepRoll(int delta) {
  if (rolls.empty()) return false;
  const auto want = static_cast<std::ptrdiff_t>(rollAt) + delta;
  if (want < 0 || want >= static_cast<std::ptrdiff_t>(rolls.size())) return false;
  rollAt = static_cast<std::size_t>(want);
  params.replaceState(rolls[rollAt].createCopy());
  invalidate();
  return true;
}

std::vector<float> HazenSamplerProcessor::voiceStarts() const {
  const juce::ScopedLock sl(uiLock);
  return ui.voiceAt;
}

std::vector<int> HazenSamplerProcessor::voiceSlices() const {
  const juce::ScopedLock sl(uiLock);
  return ui.voiceSlice;
}

juce::AudioProcessorEditor* HazenSamplerProcessor::createEditor() {
  return new HazenSamplerEditor(*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
  return new HazenSamplerProcessor();
}
