#include "PluginEditor.h"

namespace {
// Straight from the web build's tokens, so the two surfaces match.
const juce::Colour kGround{0xff0b0b0d};
const juce::Colour kRaised{0xff131316};
const juce::Colour kInk{0xffede7dc};
const juce::Colour kInkDim{0xff9a948b};
const juce::Colour kSignal{0xffff3b12};
const juce::Colour kHairline{0x1fede7dc};

juce::Font mono(float size, bool bold = false) {
  return juce::FontOptions{juce::Font::getDefaultMonospacedFontName(), size,
                           bold ? juce::Font::bold : juce::Font::plain};
}
}  // namespace

HazenSamplerEditor::HazenSamplerEditor(HazenSamplerProcessor& p)
    : AudioProcessorEditor(&p), processor(p) {
  setLookAndFeel(nullptr);

  title.setText("HAZEN sampler", juce::dontSendNotification);
  title.setFont(mono(18.0f, true));
  title.setColour(juce::Label::textColourId, kInk);
  addAndMakeVisible(title);

  statusLabel.setFont(mono(11.0f));
  statusLabel.setColour(juce::Label::textColourId, kInkDim);
  statusLabel.setJustificationType(juce::Justification::centredRight);
  addAndMakeVisible(statusLabel);

  hint.setText("midi note plays it · sync follows the host", juce::dontSendNotification);
  hint.setFont(mono(10.0f));
  hint.setColour(juce::Label::textColourId, kInkDim);
  addAndMakeVisible(hint);

  loadButton.setColour(juce::TextButton::buttonColourId, kRaised);
  loadButton.setColour(juce::TextButton::textColourOffId, kInk);
  addAndMakeVisible(loadButton);
  loadButton.onClick = [this] {
    chooser = std::make_unique<juce::FileChooser>(
        "Load a sample", juce::File{}, "*.wav;*.aif;*.aiff;*.mp3;*.flac;*.m4a;*.caf");
    chooser->launchAsync(juce::FileBrowserComponent::openMode |
                             juce::FileBrowserComponent::canSelectFiles,
                         [this](const juce::FileChooser& fc) {
                           const auto file = fc.getResult();
                           if (file.existsAsFile()) processor.loadSample(file);
                         });
  };

  addChoice(mode, "mode", "mode", {"mangle", "chop"});
  addChoice(bars, "bars", "bars", {"1", "2", "4", "8", "16"});
  addChoice(pattern, "pattern", "pattern", {"AAAB", "ABAB", "AABA", "ABAC", "AAAA", "ABCB"});
  addChoice(length, "length", "length", {"4 bars", "8 bars", "16 bars"});
  addChoice(cut, "cut", "cut", {"transients", "1/1", "1/2", "1/4", "1/8", "1/16"});
  addChoice(res, "res", "grid", {"1/8", "1/16"});
  addChoice(duckRate, "duckrate", "kick", {"1/1", "1/2", "1/4", "1/8"});

  addToggle(sync, "sync", "sync");
  addToggle(reverseOn, "revon", "reverse");
  addToggle(chopOn, "chopon", "chop");
  addToggle(crushOn, "crushon", "crush");
  addToggle(pitchOn, "pitchon", "pitch");
  addToggle(driveOn, "driveon", "drive");
  addToggle(verbOn, "verbon", "verb");

  addKnob(segments, "segments", "slices");
  addKnob(scatter, "scatter", "scatter");
  addKnob(stutter, "stutter", "stutter");
  addKnob(gate, "gate", "gate");
  addKnob(bits, "bits", "bits");
  addKnob(divisor, "divisor", "rate");
  addKnob(semitones, "semitones", "pitch");
  addKnob(grain, "grain", "grain");
  addKnob(drive, "drive", "drive");
  addKnob(verbSize, "verbsize", "size");
  addKnob(verbMix, "verbmix", "mix");
  addKnob(density, "density", "density");
  addKnob(variation, "variation", "variation");
  addKnob(hold, "hold", "hold");
  addKnob(duck, "duck", "duck");
  addKnob(duckRelease, "duckrel", "release");
  addKnob(level, "level", "level");

  // Any parameter move needs a re-render, and the processor coalesces them, so
  // wiring every control to the same nudge is safe and keeps this simple.
  for (auto* param : processor.getParameters()) {
    if (auto* withId = dynamic_cast<juce::AudioProcessorParameterWithID*>(param)) {
      juce::ignoreUnused(withId);
    }
  }

  setSize(880, 560);
  startTimerHz(24);
}

void HazenSamplerEditor::addKnob(Knob& k, const juce::String& id, const juce::String& text) {
  k.slider.setSliderStyle(juce::Slider::RotaryVerticalDrag);
  k.slider.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 56, 14);
  k.slider.setColour(juce::Slider::rotarySliderFillColourId, kSignal);
  k.slider.setColour(juce::Slider::rotarySliderOutlineColourId, kHairline);
  k.slider.setColour(juce::Slider::thumbColourId, kInk);
  k.slider.setColour(juce::Slider::textBoxTextColourId, kInk);
  k.slider.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
  k.slider.onValueChange = [this] { processor.invalidate(); };
  addAndMakeVisible(k.slider);

  k.label.setText(text, juce::dontSendNotification);
  k.label.setFont(mono(9.5f));
  k.label.setJustificationType(juce::Justification::centred);
  k.label.setColour(juce::Label::textColourId, kInkDim);
  addAndMakeVisible(k.label);

  k.attach = std::make_unique<SliderAttach>(processor.params, id, k.slider);
}

void HazenSamplerEditor::addToggle(Toggle& t, const juce::String& id, const juce::String& text) {
  t.button.setButtonText(text);
  t.button.setColour(juce::ToggleButton::textColourId, kInkDim);
  t.button.setColour(juce::ToggleButton::tickColourId, kSignal);
  t.button.onClick = [this] { processor.invalidate(); };
  addAndMakeVisible(t.button);
  t.attach = std::make_unique<ButtonAttach>(processor.params, id, t.button);
}

void HazenSamplerEditor::addChoice(Choice& c, const juce::String& id, const juce::String& text,
                                   const juce::StringArray& options) {
  c.box.addItemList(options, 1);
  c.box.setColour(juce::ComboBox::backgroundColourId, kRaised);
  c.box.setColour(juce::ComboBox::textColourId, kInk);
  c.box.setColour(juce::ComboBox::outlineColourId, kHairline);
  c.box.setColour(juce::ComboBox::arrowColourId, kSignal);
  c.box.onChange = [this] { processor.invalidate(); };
  addAndMakeVisible(c.box);

  c.label.setText(text, juce::dontSendNotification);
  c.label.setFont(mono(9.5f));
  c.label.setColour(juce::Label::textColourId, kSignal);
  addAndMakeVisible(c.label);

  c.attach = std::make_unique<ComboAttach>(processor.params, id, c.box);
}

void HazenSamplerEditor::timerCallback() {
  wave = processor.peaks(juce::jmax(1, waveArea.getWidth() / 3));
  playhead = processor.playPosition();

  auto text = processor.status();
  if (processor.isRendering()) text += " · rendering";
  else if (processor.hasSample()) text += " · " + juce::String(processor.renderedSeconds(), 2) + "s";
  statusLabel.setText(text, juce::dontSendNotification);

  const bool chopMode = mode.box.getSelectedItemIndex() == 1;
  // Only show the controls that apply. A knob that silently does nothing in the
  // current mode is worse than an absent one.
  for (auto* c : {&pattern.box, &length.box, &cut.box, &res.box}) c->setVisible(chopMode);
  for (auto* l : {&pattern.label, &length.label, &cut.label, &res.label}) l->setVisible(chopMode);
  for (auto* k : {&density, &variation, &hold}) {
    k->slider.setVisible(chopMode);
    k->label.setVisible(chopMode);
  }
  bars.box.setVisible(!chopMode);
  bars.label.setVisible(!chopMode);
  for (auto* t : {&reverseOn, &chopOn, &crushOn, &pitchOn, &driveOn, &verbOn}) {
    t->button.setVisible(!chopMode);
  }
  for (auto* k : {&segments, &scatter, &stutter, &gate, &bits, &divisor, &semitones, &grain,
                  &drive, &verbSize, &verbMix}) {
    k->slider.setVisible(!chopMode);
    k->label.setVisible(!chopMode);
  }
  repaint(waveArea);
}

void HazenSamplerEditor::paint(juce::Graphics& g) {
  g.fillAll(kGround);

  // The same faint rule grid as the web build.
  g.setColour(juce::Colour{0x0dede7dc});
  for (int x = 0; x < getWidth(); x += 44) g.drawVerticalLine(x, 0.0f, float(getHeight()));

  g.setColour(kSignal);
  g.setFont(mono(18.0f, true));
  g.drawText("HAZEN", 16, 12, 80, 24, juce::Justification::left);

  // Waveform panel.
  g.setColour(kRaised);
  g.fillRect(waveArea);
  g.setColour(kHairline);
  g.drawRect(waveArea, 1);

  if (wave.empty()) {
    g.setColour(kInkDim);
    g.setFont(mono(12.0f));
    g.drawText(processor.hasSample() ? "rendering…" : "drop a sample here, or load one",
               waveArea, juce::Justification::centred);
    return;
  }

  const float mid = float(waveArea.getCentreY());
  const float half = float(waveArea.getHeight()) * 0.46f;
  const int played = playhead >= 0.0f ? int(playhead * float(wave.size())) : int(wave.size());
  for (std::size_t i = 0; i < wave.size(); ++i) {
    const float x = float(waveArea.getX()) + float(i) * 3.0f + 1.0f;
    const float h = juce::jmax(1.0f, wave[i] * half);
    g.setColour(int(i) <= played ? kSignal : kSignal.withAlpha(0.35f));
    g.drawLine(x, mid - h, x, mid + h, 2.0f);
  }
  if (playhead >= 0.0f) {
    g.setColour(kInk);
    const float x = float(waveArea.getX()) + playhead * float(waveArea.getWidth());
    g.drawLine(x, float(waveArea.getY()), x, float(waveArea.getBottom()), 1.0f);
  }
}

void HazenSamplerEditor::layoutRow(juce::Rectangle<int> area, const juce::String& title,
                                   std::vector<juce::Component*> items) {
  juce::ignoreUnused(title);
  if (items.empty()) return;
  const int w = area.getWidth() / int(items.size());
  for (auto* item : items) {
    auto cell = area.removeFromLeft(w).reduced(4);
    item->setBounds(cell);
  }
}

void HazenSamplerEditor::resized() {
  auto area = getLocalBounds().reduced(16);

  auto top = area.removeFromTop(30);
  title.setBounds(top.removeFromLeft(240).withTrimmedLeft(84));
  statusLabel.setBounds(top);

  area.removeFromTop(6);
  waveArea = area.removeFromTop(120);
  area.removeFromTop(10);

  auto head = area.removeFromTop(46);
  auto headLeft = head.removeFromLeft(head.getWidth() / 2);
  mode.label.setBounds(headLeft.removeFromTop(12));
  auto modeRow = headLeft;
  mode.box.setBounds(modeRow.removeFromLeft(110).reduced(2));
  bars.box.setBounds(modeRow.removeFromLeft(70).reduced(2));
  bars.label.setBounds(bars.box.getBounds().translated(0, -14).withHeight(12));
  sync.button.setBounds(modeRow.removeFromLeft(90).reduced(2));
  loadButton.setBounds(head.removeFromRight(150).reduced(2));
  hint.setBounds(head);

  area.removeFromTop(8);

  // Chop controls and mangle controls occupy the same space; only one set is
  // visible at a time, so they can share it.
  auto choices = area.removeFromTop(46);
  {
    auto row = choices;
    for (auto* c : {&pattern, &length, &cut, &res}) {
      auto cell = row.removeFromLeft(row.getWidth() / 4).reduced(3);
      c->label.setBounds(cell.removeFromTop(12));
      c->box.setBounds(cell);
    }
  }

  auto knobRow1 = area.removeFromTop(96);
  auto knobRow2 = area.removeFromTop(96);

  // Mangle: toggles above their knobs, so a module reads as a module.
  {
    auto row = knobRow1;
    auto cellFor = [&row](int count) { return row.removeFromLeft(row.getWidth() / count); };
    juce::ignoreUnused(cellFor);
    std::vector<juce::Component*> a{&reverseOn.button, &chopOn.button, &segments.slider,
                                    &scatter.slider,  &stutter.slider, &gate.slider};
    layoutRow(knobRow1, "chop", a);
    for (auto* k : {&segments, &scatter, &stutter, &gate}) {
      k->label.setBounds(k->slider.getBounds().removeFromBottom(12).translated(0, 12));
    }
  }
  {
    std::vector<juce::Component*> b{&crushOn.button, &bits.slider,     &divisor.slider,
                                   &pitchOn.button, &semitones.slider, &grain.slider,
                                   &driveOn.button, &drive.slider,     &verbOn.button,
                                   &verbSize.slider, &verbMix.slider};
    layoutRow(knobRow2, "tone", b);
    for (auto* k : {&bits, &divisor, &semitones, &grain, &drive, &verbSize, &verbMix}) {
      k->label.setBounds(k->slider.getBounds().removeFromBottom(12).translated(0, 12));
    }
  }
  // Chop knobs share knobRow1.
  {
    auto row = knobRow1;
    std::vector<juce::Component*> c{&density.slider, &variation.slider, &hold.slider};
    layoutRow(row, "feel", c);
    for (auto* k : {&density, &variation, &hold}) {
      k->label.setBounds(k->slider.getBounds().removeFromBottom(12).translated(0, 12));
    }
  }

  auto out = area.removeFromTop(96);
  {
    std::vector<juce::Component*> d{&duck.slider, &duckRelease.slider, &duckRate.box,
                                    &level.slider};
    layoutRow(out, "out", d);
    for (auto* k : {&duck, &duckRelease, &level}) {
      k->label.setBounds(k->slider.getBounds().removeFromBottom(12).translated(0, 12));
    }
    duckRate.label.setBounds(duckRate.box.getBounds().translated(0, -14).withHeight(12));
  }
}

bool HazenSamplerEditor::isInterestedInFileDrag(const juce::StringArray& files) {
  for (const auto& f : files) {
    // Deliberately wide. A file the host refuses to even offer is worse than one
    // that fails with a message, which is the lesson the web build learned the
    // hard way with AIFF and CAF.
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
