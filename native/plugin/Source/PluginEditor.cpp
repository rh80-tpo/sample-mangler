#include "PluginEditor.h"

namespace {
// Straight from the web build's tokens, so the two surfaces match.
const juce::Colour kGround{0xff0b0b0d};
const juce::Colour kRaised{0xff131316};
const juce::Colour kSunken{0xff08080a};
const juce::Colour kInk{0xffede7dc};
const juce::Colour kInkDim{0xff9a948b};
const juce::Colour kInkFaint{0xff6f6a63};
const juce::Colour kSignal{0xffff3b12};
const juce::Colour kHairline{0x1fede7dc};
const juce::Colour kHairlineStrong{0x3aede7dc};

/// Written as bytes rather than as a literal: the source file's encoding is not
/// something to bet the interface on, and the first build shipped "Â·".
const juce::String kDot = juce::String::fromUTF8(" \xc2\xb7 ");

/// Chop tints. Four, separated by lightness rather than hue, for the same reason
/// the web build's are: a warm hue ramp at constant lightness collapses to one
/// colour under red-green colour blindness.
const juce::Colour kTints[4] = {
    juce::Colour::fromHSL(8.0f / 360.0f, 0.90f, 0.34f, 1.0f),
    juce::Colour::fromHSL(22.0f / 360.0f, 0.86f, 0.50f, 1.0f),
    juce::Colour::fromHSL(36.0f / 360.0f, 0.84f, 0.66f, 1.0f),
    juce::Colour::fromHSL(48.0f / 360.0f, 0.82f, 0.82f, 1.0f),
};

juce::Font mono(float size, bool bold = false) {
  return juce::Font{juce::FontOptions{juce::Font::getDefaultMonospacedFontName(), size,
                                      bold ? juce::Font::bold : juce::Font::plain}};
}

/// Section chrome: a titled box. Returns the space left inside it.
juce::Rectangle<int> panel(juce::Graphics& g, juce::Rectangle<int> area,
                           const juce::String& title) {
  const auto r = area.toFloat();
  // A shallow vertical gradient and a single bright top edge. This is the whole
  // trick behind panels that look moulded rather than drawn: light appears to
  // come from above, so a flat rectangle reads as a raised surface.
  g.setGradientFill(juce::ColourGradient{kRaised.brighter(0.05f), r.getCentreX(), r.getY(),
                                         kRaised.darker(0.22f), r.getCentreX(), r.getBottom(),
                                         false});
  g.fillRoundedRectangle(r, 3.0f);
  g.setColour(kInk.withAlpha(0.055f));
  g.drawLine(r.getX() + 3.0f, r.getY() + 0.5f, r.getRight() - 3.0f, r.getY() + 0.5f, 1.0f);
  g.setColour(kHairline);
  g.drawRoundedRectangle(r.reduced(0.5f), 3.0f, 1.0f);
  auto inner = area.reduced(10, 8);
  if (title.isNotEmpty()) {
    g.setColour(kSignal);
    g.setFont(mono(9.5f));
    g.drawText(title.toUpperCase(), inner.removeFromTop(12), juce::Justification::topLeft);
    inner.removeFromTop(2);
  }
  return inner;
}

/// The knob face. Thin arc, ink pointer, matching the web build's dial.
class KnobLook : public juce::LookAndFeel_V4 {
 public:
  KnobLook() {
    setColour(juce::Slider::textBoxTextColourId, kInk);
    setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    setColour(juce::Slider::textBoxBackgroundColourId, juce::Colours::transparentBlack);
    setColour(juce::ComboBox::backgroundColourId, kSunken);
    setColour(juce::ComboBox::textColourId, kInk);
    setColour(juce::ComboBox::outlineColourId, kHairlineStrong);
    setColour(juce::ComboBox::arrowColourId, kSignal);
    setColour(juce::PopupMenu::backgroundColourId, kRaised);
    setColour(juce::PopupMenu::textColourId, kInk);
    setColour(juce::PopupMenu::highlightedBackgroundColourId, kSignal);
    setColour(juce::PopupMenu::highlightedTextColourId, kGround);
    setColour(juce::TextButton::buttonColourId, kSunken);
    setColour(juce::TextButton::textColourOffId, kInk);
    setColour(juce::ToggleButton::textColourId, kInkDim);
    setColour(juce::ToggleButton::tickColourId, kSignal);
    setColour(juce::ToggleButton::tickDisabledColourId, kHairlineStrong);
  }

  void drawRotarySlider(juce::Graphics& g, int x, int y, int w, int h, float pos,
                        float startAngle, float endAngle, juce::Slider& s) override {
    const auto bounds = juce::Rectangle<int>(x, y, w, h).toFloat().reduced(3.0f);
    const auto radius = juce::jmin(bounds.getWidth(), bounds.getHeight()) / 2.0f;
    if (radius < 6.0f) return;
    const auto centre = bounds.getCentre();
    const auto angle = startAngle + pos * (endAngle - startAngle);
    const float ring = juce::jmax(2.5f, radius * 0.15f);
    const float capR = radius - ring * 1.9f;
    const bool live = s.isEnabled();

    // Tick marks around the travel. Cheap, and it is most of what separates a
    // dial that looks like a control from a coloured arc.
    g.setColour(kInk.withAlpha(live ? 0.16f : 0.07f));
    for (int i = 0; i <= 10; ++i) {
      const float a = startAngle + (endAngle - startAngle) * (float(i) / 10.0f);
      const auto outer = centre.getPointOnCircumference(radius + 1.5f, a);
      const auto tickIn = centre.getPointOnCircumference(radius - 0.5f, a);
      g.drawLine({tickIn, outer}, i % 5 == 0 ? 1.2f : 0.7f);
    }

    juce::Path track;
    track.addCentredArc(centre.x, centre.y, radius - ring, radius - ring, 0.0f, startAngle,
                        endAngle, true);
    g.setColour(kInk.withAlpha(live ? 0.13f : 0.06f));
    g.strokePath(track, juce::PathStrokeType{ring, juce::PathStrokeType::curved,
                                             juce::PathStrokeType::rounded});

    if (pos > 0.002f) {
      juce::Path fill;
      fill.addCentredArc(centre.x, centre.y, radius - ring, radius - ring, 0.0f, startAngle,
                         angle, true);
      // A hint of glow under the arc, so the signal colour reads as emitted
      // rather than painted.
      g.setColour(kSignal.withAlpha(live ? 0.22f : 0.08f));
      g.strokePath(fill, juce::PathStrokeType{ring * 2.1f, juce::PathStrokeType::curved,
                                              juce::PathStrokeType::rounded});
      g.setColour(live ? kSignal : kSignal.withAlpha(0.35f));
      g.strokePath(fill, juce::PathStrokeType{ring, juce::PathStrokeType::curved,
                                              juce::PathStrokeType::rounded});
    }

    // The cap: dropped shadow, then a top-lit gradient. Same lighting model as
    // the panels, so the whole face agrees about where the light is.
    const auto cap = juce::Rectangle<float>{capR * 2.0f, capR * 2.0f}.withCentre(centre);
    g.setColour(juce::Colours::black.withAlpha(0.45f));
    g.fillEllipse(cap.translated(0.0f, 1.6f));
    g.setGradientFill(juce::ColourGradient{juce::Colour{0xff2a2a30}, cap.getCentreX(), cap.getY(),
                                           juce::Colour{0xff14141a}, cap.getCentreX(),
                                           cap.getBottom(), false});
    g.fillEllipse(cap);
    g.setColour(kInk.withAlpha(0.10f));
    g.drawEllipse(cap.reduced(0.5f), 1.0f);

    // Pointer, inset into the cap rather than laid over it.
    const auto from = centre.getPointOnCircumference(capR * 0.30f, angle);
    const auto to = centre.getPointOnCircumference(capR * 0.92f, angle);
    g.setColour(juce::Colours::black.withAlpha(0.5f));
    g.drawLine({from.translated(0.0f, 1.0f), to.translated(0.0f, 1.0f)}, 2.4f);
    g.setColour(live ? kInk : kInkFaint);
    g.drawLine({from, to}, 2.0f);
  }

  void drawButtonBackground(juce::Graphics& g, juce::Button& b, const juce::Colour& colour,
                            bool hover, bool down) override {
    const auto r = b.getLocalBounds().toFloat().reduced(0.5f);
    const auto base = colour.withMultipliedBrightness(down ? 0.86f : hover ? 1.12f : 1.0f);
    g.setColour(juce::Colours::black.withAlpha(0.35f));
    g.fillRoundedRectangle(r.translated(0.0f, 1.0f), 3.0f);
    g.setGradientFill(juce::ColourGradient{base.brighter(0.10f), r.getCentreX(), r.getY(),
                                           base.darker(0.14f), r.getCentreX(), r.getBottom(),
                                           false});
    g.fillRoundedRectangle(r, 3.0f);
    g.setColour(kInk.withAlpha(0.14f));
    g.drawRoundedRectangle(r, 3.0f, 1.0f);
  }

};

KnobLook& look() {
  static KnobLook instance;
  return instance;
}
}  // namespace

HazenSamplerEditor::HazenSamplerEditor(HazenSamplerProcessor& p)
    : AudioProcessorEditor(&p), processor(p) {
  setLookAndFeel(&look());

  title.setText("sampler", juce::dontSendNotification);
  title.setFont(mono(17.0f, true));
  title.setColour(juce::Label::textColourId, kInk);
  addAndMakeVisible(title);

  subtitle.setText("midi note triggers" + kDot + "sync follows the host",
                   juce::dontSendNotification);
  subtitle.setFont(mono(9.5f));
  subtitle.setColour(juce::Label::textColourId, kInkFaint);
  addAndMakeVisible(subtitle);

  statusLabel.setFont(mono(10.5f));
  statusLabel.setColour(juce::Label::textColourId, kInkDim);
  statusLabel.setJustificationType(juce::Justification::centredRight);
  addAndMakeVisible(statusLabel);

  hint.setFont(mono(9.5f));
  hint.setColour(juce::Label::textColourId, kInkFaint);
  addAndMakeVisible(hint);

  rollLabel.setFont(mono(9.5f));
  rollLabel.setColour(juce::Label::textColourId, kInkDim);
  rollLabel.setJustificationType(juce::Justification::centred);
  addAndMakeVisible(rollLabel);

  // Transport. Playing should not require a MIDI note or a rolling host — the
  // first thing you want after loading a sample is to hear it.
  playButton.setColour(juce::TextButton::buttonColourId, kSunken);
  stopButton.setColour(juce::TextButton::buttonColourId, kSunken);
  exportButton.setColour(juce::TextButton::buttonColourId, kSunken);
  for (auto* b : {&playButton, &stopButton, &exportButton}) addAndMakeVisible(b);
  playButton.onClick = [this] { processor.startPlayback(); };
  stopButton.onClick = [this] { processor.stopPlayback(); };
  exportButton.onClick = [this] {
    chooser = std::make_unique<juce::FileChooser>(
        "Export the loop", juce::File::getSpecialLocation(juce::File::userMusicDirectory)
                               .getChildFile(processor.exportName() + ".wav"),
        "*.wav");
    chooser->launchAsync(juce::FileBrowserComponent::saveMode |
                             juce::FileBrowserComponent::canSelectFiles |
                             juce::FileBrowserComponent::warnAboutOverwriting,
                         [this](const juce::FileChooser& fc) {
                           const auto file = fc.getResult();
                           if (file != juce::File{}) processor.exportTo(file);
                         });
  };

  addAndMakeVisible(dragOut);
  addAndMakeVisible(loadButton);
  loadButton.onClick = [this] {
    chooser = std::make_unique<juce::FileChooser>(
        "Load a sample", juce::File{}, "*.wav;*.aif;*.aiff;*.mp3;*.flac;*.m4a;*.caf;*.ogg");
    chooser->launchAsync(juce::FileBrowserComponent::openMode |
                             juce::FileBrowserComponent::canSelectFiles,
                         [this](const juce::FileChooser& fc) {
                           const auto file = fc.getResult();
                           if (file.existsAsFile()) processor.loadSample(file);
                         });
  };

  rerollButton.setColour(juce::TextButton::buttonColourId, kSignal);
  rerollButton.setColour(juce::TextButton::textColourOffId, kGround);
  addAndMakeVisible(rerollButton);
  rerollButton.onClick = [this] { processor.reroll(); };

  // The chopper's own two actions. Without a rechop the rhythm was seeded and
  // every chop of a given setup came out identical, with no way to ask for
  // another take.
  rechopButton.setColour(juce::TextButton::buttonColourId, kSunken);
  chopMangleButton.setColour(juce::TextButton::buttonColourId, kSignal);
  chopMangleButton.setColour(juce::TextButton::textColourOffId, kGround);
  addAndMakeVisible(rechopButton);
  addAndMakeVisible(chopMangleButton);
  rechopButton.onClick = [this] { processor.rechop(); };
  chopMangleButton.onClick = [this] { processor.chopAndMangle(); };

  for (auto* b : {&rollBack, &rollForward}) addAndMakeVisible(b);
  rollBack.onClick = [this] { processor.stepRoll(-1); };
  rollForward.onClick = [this] { processor.stepRoll(1); };

  addChoice(mode, "mode", "mode", {"mangle", "chop"});
  addChoice(bars, "bars", "bars", {"1", "2", "4", "8", "16"});
  addChoice(pattern, "pattern", "pattern", {"AAAB", "ABAB", "AABA", "ABAC", "AAAA", "ABCB"});
  addChoice(length, "length", "length", {"4 bars", "8 bars", "16 bars"});
  addChoice(cut, "cut", "cut", {"transients", "1/1", "1/2", "1/4", "1/8", "1/16"});
  addChoice(res, "res", "grid", {"1/8", "1/16"});
  addChoice(duckRate, "duckrate", "kick", {"1/1", "1/2", "1/4", "1/8"});
  mode.box.onChange = [this] {
    applyMode();
    resized();
    repaint();
    processor.invalidate();
  };

  addSwitch(sync, "sync", "sync");
  addSwitch(reverseOn, "revon", "on");
  addSwitch(chopOn, "chopon", "on");
  addSwitch(crushOn, "crushon", "on");
  addSwitch(pitchOn, "pitchon", "on");
  addSwitch(driveOn, "driveon", "on");
  addSwitch(verbOn, "verbon", "on");

  addKnob(tempo, "tempo", "bpm", Unit::Integer);
  addKnob(segments, "segments", "slices", Unit::Integer);
  addKnob(scatter, "scatter", "scatter", Unit::Percent);
  addKnob(stutter, "stutter", "stutter", Unit::Percent);
  addKnob(gate, "gate", "gate", Unit::Percent);
  addKnob(bits, "bits", "bits", Unit::Integer);
  addKnob(divisor, "divisor", "rate", Unit::Integer);
  addKnob(semitones, "semitones", "pitch", Unit::Semitones);
  addKnob(grain, "grain", "grain", Unit::Millis);
  addKnob(drive, "drive", "drive", Unit::Percent);
  addKnob(verbSize, "verbsize", "size", Unit::Percent);
  addKnob(verbDamp, "verbdamp", "damp", Unit::Hertz);
  addKnob(verbMix, "verbmix", "mix", Unit::Percent);
  addKnob(density, "density", "density", Unit::Percent);
  addKnob(variation, "variation", "variation", Unit::Percent);
  addKnob(hold, "hold", "hold", Unit::Percent);
  addKnob(duck, "duck", "duck", Unit::Percent);
  addKnob(duckRelease, "duckrel", "release", Unit::Percent);
  addKnob(level, "level", "level", Unit::Decibels);

  // The rack, as modules. Order matches the chain the processor runs.
  mangleModules = {
      {"01 reverse", &reverseOn, {}, {}},
      {"02 chop", &chopOn, {&segments, &scatter, &stutter, &gate}, {}},
      {"03 pitch", &pitchOn, {&semitones, &grain}, {}},
      {"04 crush", &crushOn, {&bits, &divisor}, {}},
      {"05 drive", &driveOn, {&drive}, {}},
      {"06 verb", &verbOn, {&verbSize, &verbDamp, &verbMix}, {}},
  };

  applyMode();
  // Tall enough for the sections to actually fit. They summed to ~790 in a 700
  // window before, so sidechain and out were laid out past the bottom edge and
  // their knobs simply were not there.
  setSize(920, 792);
  startTimerHz(20);
}

HazenSamplerEditor::~HazenSamplerEditor() { setLookAndFeel(nullptr); }

bool HazenSamplerEditor::chopMode() const { return mode.box.getSelectedItemIndex() == 1; }

void HazenSamplerEditor::addKnob(Knob& k, const juce::String& id, const juce::String& caption,
                                 Unit unit) {
  k.slider.setName(caption);
  k.slider.setSliderStyle(juce::Slider::RotaryVerticalDrag);
  k.slider.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 58, 13);
  k.slider.setColour(juce::Slider::textBoxTextColourId, kInk);
  k.slider.onValueChange = [this] { processor.invalidate(); };
  addAndMakeVisible(k.slider);

  k.caption.setText(caption, juce::dontSendNotification);
  k.caption.setFont(mono(9.0f));
  k.caption.setJustificationType(juce::Justification::centredTop);
  k.caption.setColour(juce::Label::textColourId, kInkFaint);
  addAndMakeVisible(k.caption);

  k.attach = std::make_unique<SliderAttach>(processor.params, id, k.slider);

  // After the attachment, deliberately. SliderAttachment installs the
  // parameter's own text conversion, so assigning these first meant the first
  // build displayed "0.4000000" where the site shows "40".
  k.slider.textFromValueFunction = [unit](double v) -> juce::String {
    switch (unit) {
      case Unit::Percent: return juce::String(juce::roundToInt(v * 100.0));
      case Unit::Integer: return juce::String(juce::roundToInt(v));
      case Unit::Semitones:
        return (v > 0 ? "+" : "") + juce::String(v, v == std::floor(v) ? 0 : 1);
      case Unit::Millis: return juce::String(juce::roundToInt(v * 1000.0)) + "ms";
      case Unit::Hertz:
        return v >= 1000.0 ? juce::String(v / 1000.0, 1) + "k"
                           : juce::String(juce::roundToInt(v));
      case Unit::Decibels: return v <= -48.0 ? "off" : juce::String(v, 1);
    }
    return juce::String(v);
  };
  k.slider.valueFromTextFunction = [](const juce::String& t) { return t.getDoubleValue(); };
  k.slider.updateText();
}

void HazenSamplerEditor::addSwitch(Switch& s, const juce::String& id,
                                   const juce::String& text) {
  s.button.setButtonText(text);
  s.button.onClick = [this] { processor.invalidate(); };
  addAndMakeVisible(s.button);
  s.attach = std::make_unique<ButtonAttach>(processor.params, id, s.button);
}

void HazenSamplerEditor::addChoice(Choice& c, const juce::String& id,
                                   const juce::String& caption,
                                   const juce::StringArray& options) {
  c.box.addItemList(options, 1);
  c.box.onChange = [this] { processor.invalidate(); };
  addAndMakeVisible(c.box);

  c.caption.setText(caption, juce::dontSendNotification);
  c.caption.setFont(mono(9.0f));
  c.caption.setColour(juce::Label::textColourId, kSignal);
  addAndMakeVisible(c.caption);

  c.attach = std::make_unique<ComboAttach>(processor.params, id, c.box);
}

void HazenSamplerEditor::applyMode() {
  const bool chop = chopMode();

  // Mangle-only.
  for (auto* c : {&bars}) {
    c->box.setVisible(!chop);
    c->caption.setVisible(!chop);
  }
  rerollButton.setVisible(!chop);
  rollBack.setVisible(!chop);
  rollForward.setVisible(!chop);
  rollLabel.setVisible(!chop);
  rechopButton.setVisible(chop);
  chopMangleButton.setVisible(chop);
  for (auto& m : mangleModules) {
    if (m.power) m.power->button.setVisible(!chop);
    for (auto* k : m.knobs) {
      k->slider.setVisible(!chop);
      k->caption.setVisible(!chop);
    }
  }

  // Chop-only.
  for (auto* c : {&pattern, &length, &cut, &res}) {
    c->box.setVisible(chop);
    c->caption.setVisible(chop);
  }
  for (auto* k : {&density, &variation, &hold}) {
    k->slider.setVisible(chop);
    k->caption.setVisible(chop);
  }
}

void HazenSamplerEditor::timerCallback() {
  wave = processor.peaks(juce::jmax(1, waveArea.getWidth() - 2));
  core = processor.rms(juce::jmax(1, waveArea.getWidth() - 2));
  voiceAt = processor.voiceStarts();
  voiceSlice = processor.voiceSlices();
  playhead = processor.playPosition();

  juce::String text = processor.status();
  if (processor.isRendering()) text += kDot + "rendering";
  else if (processor.renderedSeconds() > 0.0)
    text += kDot + juce::String(processor.renderedSeconds(), 2) + "s";
  statusLabel.setText(text, juce::dontSendNotification);

  hint.setText(sync.button.getToggleState()
                   ? "grid: host tempo" + kDot + juce::String(processor.tempo(), 1) + " bpm"
                   : "grid: " + juce::String(processor.tempo(), 1) + " bpm",
               juce::dontSendNotification);
  tempo.slider.setEnabled(!sync.button.getToggleState());

  const int count = processor.rollCount();
  rollLabel.setText(count > 0 ? juce::String(processor.rollIndex() + 1) + "/" +
                                    juce::String(count)
                              : "-",
                    juce::dontSendNotification);
  rollBack.setEnabled(processor.rollIndex() > 0);
  rollForward.setEnabled(count > 0 && processor.rollIndex() < count - 1);

  playButton.setEnabled(processor.renderedSeconds() > 0.0 && !processor.isPlaying());
  stopButton.setEnabled(processor.isPlaying());
  exportButton.setEnabled(processor.renderedSeconds() > 0.0);
  dragOut.repaint();

  repaint(waveArea);
}

void HazenSamplerEditor::paint(juce::Graphics& g) {
  g.fillAll(kGround);
  g.setColour(juce::Colour{0x0dede7dc});
  for (int x = 0; x < getWidth(); x += 44) g.drawVerticalLine(x, 0.0f, float(getHeight()));

  g.setColour(kSignal);
  g.setFont(mono(17.0f, true));
  g.drawText("HAZEN", 16, 14, 76, 22, juce::Justification::left);

  // --- waveform -------------------------------------------------------
  {
    const auto r = waveArea.toFloat();
    // Sunken, not raised: dark at the top edge is what reads as recessed, and the
    // waveform should look inset into the face rather than sitting on it.
    g.setGradientFill(juce::ColourGradient{kSunken.darker(0.5f), r.getCentreX(), r.getY(),
                                           kSunken, r.getCentreX(), r.getBottom(), false});
    g.fillRoundedRectangle(r, 3.0f);
    g.setColour(juce::Colours::black.withAlpha(0.55f));
    g.drawLine(r.getX() + 3.0f, r.getY() + 0.5f, r.getRight() - 3.0f, r.getY() + 0.5f, 1.0f);
    g.setColour(kHairline);
    g.drawRoundedRectangle(r.reduced(0.5f), 3.0f, 1.0f);
  }

  if (wave.empty()) {
    g.setColour(kInkFaint);
    g.setFont(mono(11.0f));
    g.drawText(processor.hasSample() ? "rendering" : "drop a sample here, or load one",
               waveArea, juce::Justification::centred);
  } else {
    const auto inner = waveArea.reduced(1);
    const float mid = float(inner.getCentreY());
    const float half = float(inner.getHeight()) * 0.47f;
    const int played =
        playhead >= 0.0f ? int(playhead * float(wave.size())) : int(wave.size());

    // A tint per chop where there are chops, one colour where there are not.
    // Drawn as a column per pixel, so it reads as an envelope and not a barcode.
    std::vector<int> tintFor(wave.size(), -1);
    if (!voiceAt.empty()) {
      for (std::size_t v = 0; v < voiceAt.size(); ++v) {
        const auto from = std::size_t(voiceAt[v] * float(wave.size()));
        const auto to = v + 1 < voiceAt.size()
                            ? std::size_t(voiceAt[v + 1] * float(wave.size()))
                            : wave.size();
        const int slice = v < voiceSlice.size() ? voiceSlice[v] : 0;
        for (auto i = from; i < to && i < wave.size(); ++i) tintFor[i] = slice % 4;
      }
    }

    // Envelope first, then a brighter rms core inside it. Peak alone cannot tell
    // a dense loud passage from a spiky one, and that difference is most of what
    // you read a waveform for.
    for (std::size_t i = 0; i < wave.size(); ++i) {
      const float x = float(inner.getX() + int(i));
      const float h = juce::jmax(0.75f, wave[i] * half);
      const auto base = tintFor[i] >= 0 ? kTints[tintFor[i]] : kSignal;
      const bool lit = int(i) <= played;
      g.setColour(lit ? base.withAlpha(0.68f) : base.withAlpha(0.20f));
      g.drawLine(x, mid - h, x, mid + h, 1.0f);
    }
    for (std::size_t i = 0; i < core.size() && i < wave.size(); ++i) {
      const float r = core[i] * half * 1.5f;
      if (r < 0.6f) continue;
      const float x = float(inner.getX() + int(i));
      const auto base = tintFor[i] >= 0 ? kTints[tintFor[i]] : kSignal;
      g.setColour(int(i) <= played ? base.brighter(0.35f) : base.withAlpha(0.34f));
      g.drawLine(x, mid - r, x, mid + r, 1.0f);
    }

    // Boundary ticks, so the chops are separable without relying on colour.
    if (!voiceAt.empty()) {
      g.setColour(kInk.withAlpha(0.85f));
      const float tick = juce::jmax(4.0f, float(inner.getHeight()) * 0.10f);
      for (const auto at : voiceAt) {
        const float x = float(inner.getX()) + at * float(inner.getWidth());
        g.drawLine(x, float(inner.getY()), x, float(inner.getY()) + tick, 1.0f);
        g.drawLine(x, float(inner.getBottom()) - tick, x, float(inner.getBottom()), 1.0f);
      }
    }

    if (playhead >= 0.0f) {
      g.setColour(kInk);
      const float x = float(inner.getX()) + playhead * float(inner.getWidth());
      g.drawLine(x, float(inner.getY()), x, float(inner.getBottom()), 1.0f);
    }
  }

  // --- section chrome -------------------------------------------------
  panel(g, sourceArea, "source");
  panel(g, transportArea, "tempo");
  if (chopMode()) {
    panel(g, chopArea, "shape");
    panel(g, feelArea, "feel");
  } else {
    // Each module gets its own box, which is what makes a rack read as a rack.
    for (const auto& m : mangleModules) {
      if (m.bounds.isEmpty()) continue;
      g.setColour(kRaised);
      g.fillRect(m.bounds);
      g.setColour(kHairline);
      g.drawRect(m.bounds, 1);
      const bool on = m.power && m.power->button.getToggleState();
      g.setColour(on ? kSignal : kInkFaint);
      g.setFont(mono(9.0f));
      g.drawText(m.title.toUpperCase(), m.bounds.reduced(8, 6).removeFromTop(11),
                 juce::Justification::topLeft);
    }
  }
  panel(g, sideArea, "sidechain");
  panel(g, outArea, "out");
}

void HazenSamplerEditor::placeKnobs(juce::Rectangle<int> area,
                                    const std::vector<Knob*>& knobs) {
  if (knobs.empty()) return;
  // A fixed cell, not the area divided by the count. Dividing made a two-knob
  // module give each dial 190px of width and 40 of height, which draws a squat
  // oval; knobs should be the same size everywhere and left-aligned in their box.
  const int cell = 72;
  for (auto* k : knobs) {
    auto slot = area.removeFromLeft(cell).reduced(2, 0);
    // Caption below the dial's own value box, so nothing overlaps.
    k->caption.setBounds(slot.removeFromBottom(11));
    k->slider.setBounds(slot);
  }
}

void HazenSamplerEditor::resized() {
  auto area = getLocalBounds().reduced(14);

  auto head = area.removeFromTop(34);
  title.setBounds(head.removeFromLeft(190).withTrimmedLeft(76));
  statusLabel.setBounds(head.removeFromRight(360));
  subtitle.setBounds(head);

  area.removeFromTop(6);
  waveArea = area.removeFromTop(128);
  area.removeFromTop(8);

  // source: load, drop hint, mode
  sourceArea = area.removeFromTop(58);
  {
    auto inner = sourceArea.reduced(10, 8);
    inner.removeFromTop(14);
    loadButton.setBounds(inner.removeFromLeft(140).reduced(0, 2));
    inner.removeFromLeft(10);
    auto modeCell = inner.removeFromLeft(110);
    mode.caption.setBounds(modeCell.removeFromTop(10));
    mode.box.setBounds(modeCell.reduced(0, 1));
    inner.removeFromLeft(12);
    playButton.setBounds(inner.removeFromLeft(64).withSizeKeepingCentre(64, 26));
    inner.removeFromLeft(4);
    stopButton.setBounds(inner.removeFromLeft(64).withSizeKeepingCentre(64, 26));
    inner.removeFromLeft(12);
    // Export sits next to the drag handle: same job, one for each habit.
    dragOut.setBounds(inner.removeFromRight(132).withSizeKeepingCentre(132, 28));
    inner.removeFromRight(6);
    exportButton.setBounds(inner.removeFromRight(96).withSizeKeepingCentre(96, 26));
    inner.removeFromRight(12);
    hint.setBounds(inner);
  }
  area.removeFromTop(6);

  // mangle/chop header row: tempo, sync, bars or nothing, reroll
  transportArea = area.removeFromTop(96);
  {
    auto inner = transportArea.reduced(10, 8);
    inner.removeFromTop(14);
    placeKnobs(inner.removeFromLeft(72), {&tempo});
    inner.removeFromLeft(8);
    sync.button.setBounds(inner.removeFromLeft(76).withSizeKeepingCentre(76, 22));
    inner.removeFromLeft(12);

    if (chopMode()) {
      auto actions = inner.removeFromRight(300);
      chopMangleButton.setBounds(actions.removeFromRight(160).withSizeKeepingCentre(160, 28));
      actions.removeFromRight(8);
      rechopButton.setBounds(actions.removeFromRight(104).withSizeKeepingCentre(104, 28));
    }

    if (!chopMode()) {
      auto barsCell = inner.removeFromLeft(80);
      bars.caption.setBounds(barsCell.removeFromTop(10));
      bars.box.setBounds(barsCell.removeFromTop(24));
      inner.removeFromLeft(12);
      // Roll history sits with reroll, since it is what reroll makes recoverable.
      auto rollCell = inner.removeFromRight(200);
      rerollButton.setBounds(rollCell.removeFromLeft(96).withSizeKeepingCentre(96, 26));
      rollBack.setBounds(rollCell.removeFromLeft(28).withSizeKeepingCentre(28, 24));
      rollLabel.setBounds(rollCell.removeFromLeft(42));
      rollForward.setBounds(rollCell.removeFromLeft(28).withSizeKeepingCentre(28, 24));
    }
  }
  area.removeFromTop(6);

  if (chopMode()) {
    chopArea = area.removeFromTop(60);
    {
      auto inner = chopArea.reduced(10, 8);
      inner.removeFromTop(14);
      for (auto* c : {&pattern, &length, &cut, &res}) {
        auto cell = inner.removeFromLeft(inner.getWidth() / 4).reduced(3, 0);
        c->caption.setBounds(cell.removeFromTop(10));
        c->box.setBounds(cell.removeFromTop(24));
      }
    }
    area.removeFromTop(6);
    feelArea = area.removeFromTop(96);
    {
      auto inner = feelArea.reduced(10, 8);
      inner.removeFromTop(14);
      placeKnobs(inner.removeFromLeft(3 * 72), {&density, &variation, &hold});
    }
    for (auto& m : mangleModules) m.bounds = {};
    mangleArea = {};
  } else {
    chopArea = {};
    feelArea = {};
    // Modules across two rows, sized to how many knobs each needs.
    mangleArea = area.removeFromTop(200);
    auto rows = mangleArea;
    auto top = rows.removeFromTop(96);
    rows.removeFromTop(8);
    auto bottom = rows.removeFromTop(96);

    auto place = [](juce::Rectangle<int>& row, Module& m, int width) {
      m.bounds = row.removeFromLeft(width);
      row.removeFromLeft(6);
      auto inner = m.bounds.reduced(8, 6);
      inner.removeFromTop(13);
      if (m.power) m.power->button.setBounds(inner.removeFromTop(20).withWidth(52));
      if (!m.knobs.empty()) placeKnobs(inner, m.knobs);
    };
    // Width from the knob count, so no module is padded out with dead space.
    auto widthFor = [](const Module& m) { return 24 + juce::jmax(1, int(m.knobs.size())) * 72; };
    place(top, mangleModules[0], 104);
    place(top, mangleModules[1], widthFor(mangleModules[1]));
    place(top, mangleModules[2], widthFor(mangleModules[2]));
    place(bottom, mangleModules[3], widthFor(mangleModules[3]));
    place(bottom, mangleModules[4], widthFor(mangleModules[4]));
    place(bottom, mangleModules[5], widthFor(mangleModules[5]));
  }
  area.removeFromTop(6);

  sideArea = area.removeFromTop(104);
  {
    auto inner = sideArea.reduced(10, 8);
    inner.removeFromTop(14);
    placeKnobs(inner.removeFromLeft(2 * 72), {&duck, &duckRelease});
    inner.removeFromLeft(10);
    auto rateCell = inner.removeFromLeft(90);
    duckRate.caption.setBounds(rateCell.removeFromTop(10));
    duckRate.box.setBounds(rateCell.removeFromTop(24));
  }
  area.removeFromTop(6);

  // Fixed, not "whatever is left": taking the remainder made the level knob
  // twice the size of every other dial.
  outArea = area.removeFromTop(104);
  {
    auto inner = outArea.reduced(10, 8);
    inner.removeFromTop(14);
    placeKnobs(inner.removeFromLeft(72), {&level});
  }
}

void HazenSamplerEditor::DragOut::paint(juce::Graphics& g) {
  const auto r = getLocalBounds().toFloat().reduced(0.5f);
  const bool ready = editor.processor.renderedSeconds() > 0.0;
  g.setColour(kSunken.withAlpha(ready ? 1.0f : 0.5f));
  g.fillRoundedRectangle(r, 3.0f);
  // Dashed, so it reads as a place to grab from rather than a button to press.
  juce::Path border;
  border.addRoundedRectangle(r, 3.0f);
  const float dashes[] = {4.0f, 3.0f};
  g.setColour(ready ? (hover ? kSignal : kHairlineStrong) : kHairline);
  g.strokePath(border, juce::PathStrokeType{1.0f}, {});
  juce::Path dashed;
  juce::PathStrokeType{1.0f}.createDashedStroke(dashed, border, dashes, 2);
  g.fillPath(dashed);

  g.setColour(ready ? (hover ? kSignal : kInkDim) : kInkFaint);
  g.setFont(mono(10.0f));
  g.drawText(ready ? "drag to a track" : "nothing to drag yet", getLocalBounds(),
             juce::Justification::centred);
}

void HazenSamplerEditor::DragOut::mouseDrag(const juce::MouseEvent&) {
  if (editor.processor.renderedSeconds() <= 0.0) return;
  const auto file = editor.processor.writeDragFile();
  if (file == juce::File{}) return;
  // An external drag, so the destination is any app that takes files — which is
  // what puts it on an Ableton audio track in one gesture.
  juce::DragAndDropContainer::performExternalDragDropOfFiles({file.getFullPathName()}, false,
                                                             &editor, nullptr);
}

bool HazenSamplerEditor::isInterestedInFileDrag(const juce::StringArray& files) {
  for (const auto& f : files) {
    // Deliberately wide. A file the host refuses to even offer is worse than one
    // that fails with a message, which is what the web build learned from AIFF.
    if (f.endsWithIgnoreCase(".wav") || f.endsWithIgnoreCase(".aif") ||
        f.endsWithIgnoreCase(".aiff") || f.endsWithIgnoreCase(".mp3") ||
        f.endsWithIgnoreCase(".flac") || f.endsWithIgnoreCase(".m4a") ||
        f.endsWithIgnoreCase(".caf") || f.endsWithIgnoreCase(".ogg")) {
      return true;
    }
  }
  return false;
}

void HazenSamplerEditor::filesDropped(const juce::StringArray& files, int, int) {
  if (files.isEmpty()) return;
  processor.loadSample(juce::File{files[0]});
}
