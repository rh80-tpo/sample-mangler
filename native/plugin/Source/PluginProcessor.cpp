// NEVER COMPILED. See ../../README.md.

#include "PluginProcessor.h"

#include "PluginEditor.h"

namespace {
constexpr const char* kBits = "bits";
constexpr const char* kRate = "rate";
constexpr const char* kDrive = "drive";
constexpr const char* kVerbMix = "verbmix";
constexpr const char* kVerbSize = "verbsize";
constexpr const char* kReverse = "reverse";
}  // namespace

juce::AudioProcessorValueTreeState::ParameterLayout HazenManglerProcessor::layout() {
  using namespace juce;
  std::vector<std::unique_ptr<RangedAudioParameter>> p;
  // Ranges mirror the web build's knobs, so a setting means the same thing in
  // both. See RANGES.md at the repository root.
  p.push_back(std::make_unique<AudioParameterInt>(ParameterID{kBits, 1}, "Bits", 1, 16, 8));
  p.push_back(std::make_unique<AudioParameterInt>(ParameterID{kRate, 1}, "Rate", 1, 32, 1));
  p.push_back(std::make_unique<AudioParameterFloat>(ParameterID{kDrive, 1}, "Drive", 0.0f, 1.0f, 0.0f));
  p.push_back(std::make_unique<AudioParameterFloat>(ParameterID{kVerbMix, 1}, "Verb Mix", 0.0f, 1.0f, 0.0f));
  p.push_back(std::make_unique<AudioParameterFloat>(ParameterID{kVerbSize, 1}, "Verb Size", 0.0f, 0.98f, 0.6f));
  p.push_back(std::make_unique<AudioParameterBool>(ParameterID{kReverse, 1}, "Reverse", false));
  return {p.begin(), p.end()};
}

HazenManglerProcessor::HazenManglerProcessor()
    : AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      params(*this, nullptr, "state", layout()) {}

void HazenManglerProcessor::prepareToPlay(double sampleRate, int) {
  sampleRate_ = sampleRate;
  reverbL_.prepare(sampleRate);
  reverbR_.prepare(sampleRate);
  decimateL_.reset();
  decimateR_.reset();
  if (source_.getNumSamples() > 0) rebuild();
}

bool HazenManglerProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
  return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}

bool HazenManglerProcessor::loadSample(const juce::File& file) {
  juce::AudioFormatManager formats;
  formats.registerBasicFormats();
  std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
  if (reader == nullptr) return false;

  source_.setSize(2, static_cast<int>(reader->lengthInSamples));
  reader->read(&source_, 0, static_cast<int>(reader->lengthInSamples), 0, true, true);
  rebuild();
  return true;
}

void HazenManglerProcessor::rebuild() {
  ready_ = false;

  const int n = source_.getNumSamples();
  if (n <= 0) return;
  rendered_.makeCopyOf(source_);

  const int bits = params.getRawParameterValue(kBits)->load();
  const int rate = params.getRawParameterValue(kRate)->load();
  const float drive = params.getRawParameterValue(kDrive)->load();
  const float mix = params.getRawParameterValue(kVerbMix)->load();
  const float size = params.getRawParameterValue(kVerbSize)->load();
  const bool rev = params.getRawParameterValue(kReverse)->load() > 0.5f;

  for (int c = 0; c < rendered_.getNumChannels(); ++c) {
    float* data = rendered_.getWritePointer(c);

    if (rev) hazen::reverse(data, static_cast<std::size_t>(n));

    hazen::Decimator dec;
    dec.set_divisor(rate);
    hazen::Reverb rv;
    rv.prepare(sampleRate_);
    rv.set_decay(size);
    rv.set_mix(mix);

    for (int i = 0; i < n; ++i) {
      float x = dec.process(data[i]);
      x = hazen::quantise(x, bits);
      if (drive > 0.0f) x = hazen::drive_curve(x, drive);
      if (mix > 0.0f) x = rv.process(x);
      data[i] = x;
    }
  }

  float* chans[2] = {rendered_.getWritePointer(0),
                     rendered_.getNumChannels() > 1 ? rendered_.getWritePointer(1)
                                                    : rendered_.getWritePointer(0)};
  hazen::normalise(chans, rendered_.getNumChannels(), static_cast<std::size_t>(n));

  ready_ = true;
}

void HazenManglerProcessor::processBlock(juce::AudioBuffer<float>& buffer,
                                         juce::MidiBuffer& midi) {
  juce::ScopedNoDenormals noDenormals;
  buffer.clear();

  // Any note on retriggers from the top. A sampler, not an effect.
  for (const auto meta : midi) {
    const auto msg = meta.getMessage();
    if (msg.isNoteOn()) playhead_ = 0;
    else if (msg.isAllNotesOff()) playhead_ = -1;
  }

  if (!ready_.load() || playhead_ < 0) return;

  const int available = rendered_.getNumSamples() - playhead_;
  const int count = juce::jmin(buffer.getNumSamples(), available);
  for (int c = 0; c < buffer.getNumChannels(); ++c) {
    const int src = juce::jmin(c, rendered_.getNumChannels() - 1);
    buffer.copyFrom(c, 0, rendered_, src, playhead_, count);
  }
  playhead_ += count;
  if (playhead_ >= rendered_.getNumSamples()) playhead_ = -1;
}

juce::AudioProcessorEditor* HazenManglerProcessor::createEditor() {
  return new HazenManglerEditor(*this);
}

void HazenManglerProcessor::getStateInformation(juce::MemoryBlock& dest) {
  if (auto state = params.copyState(); auto xml = state.createXml())
    copyXmlToBinary(*xml, dest);
}

void HazenManglerProcessor::setStateInformation(const void* data, int size) {
  if (auto xml = getXmlFromBinary(data, size))
    params.replaceState(juce::ValueTree::fromXml(*xml));
  rebuild();
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
  return new HazenManglerProcessor();
}
