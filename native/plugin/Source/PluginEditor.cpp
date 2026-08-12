// NEVER COMPILED. See ../../README.md.
//
// Same palette as the web build, so the two read as one product.

#include "PluginEditor.h"

namespace {
const juce::Colour kGround{0xff0b0b0d};
const juce::Colour kInk{0xffede7dc};
const juce::Colour kInkDim{0xff9a948b};
const juce::Colour kSignal{0xffff3b12};
}  // namespace

HazenManglerEditor::HazenManglerEditor(HazenManglerProcessor& p)
    : AudioProcessorEditor(&p), processor_(p) {
  addKnob(bits_, bitsLabel_, "bits", "BITS", bitsAttach_);
  addKnob(rate_, rateLabel_, "rate", "RATE", rateAttach_);
  addKnob(drive_, driveLabel_, "drive", "DRIVE", driveAttach_);
  addKnob(verbMix_, verbMixLabel_, "verbmix", "VERB MIX", verbMixAttach_);
  addKnob(verbSize_, verbSizeLabel_, "verbsize", "VERB SIZE", verbSizeAttach_);

  reverse_.setColour(juce::ToggleButton::textColourId, kInkDim);
  reverse_.setColour(juce::ToggleButton::tickColourId, kSignal);
  addAndMakeVisible(reverse_);
  reverseAttach_ = std::make_unique<ButtonAttachment>(processor_.params, "reverse", reverse_);

  dropHint_.setText("drop a sample", juce::dontSendNotification);
  dropHint_.setJustificationType(juce::Justification::centred);
  dropHint_.setColour(juce::Label::textColourId, kInkDim);
  addAndMakeVisible(dropHint_);

  setSize(620, 260);
}

void HazenManglerEditor::addKnob(juce::Slider& s, juce::Label& l,
                                 const juce::String& id, const juce::String& text,
                                 std::unique_ptr<Attachment>& attach) {
  s.setSliderStyle(juce::Slider::RotaryVerticalDrag);
  s.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 62, 16);
  s.setColour(juce::Slider::rotarySliderFillColourId, kSignal);
  s.setColour(juce::Slider::rotarySliderOutlineColourId, juce::Colour{0x40ede7dc});
  s.setColour(juce::Slider::thumbColourId, kInk);
  s.setColour(juce::Slider::textBoxTextColourId, kInk);
  s.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
  addAndMakeVisible(s);

  l.setText(text, juce::dontSendNotification);
  l.setJustificationType(juce::Justification::centred);
  l.setColour(juce::Label::textColourId, kInkDim);
  l.setFont(juce::Font{11.0f});
  addAndMakeVisible(l);

  attach = std::make_unique<Attachment>(processor_.params, id, s);
}

void HazenManglerEditor::paint(juce::Graphics& g) {
  g.fillAll(kGround);

  // The same faint rule grid the web build uses.
  g.setColour(juce::Colour{0x10ede7dc});
  for (int x = 0; x < getWidth(); x += 44) g.drawVerticalLine(x, 0.0f, float(getHeight()));

  g.setColour(kSignal);
  g.setFont(juce::Font{20.0f, juce::Font::bold});
  g.drawText("HAZEN", 16, 12, 90, 24, juce::Justification::left);
  g.setColour(kInk);
  g.drawText("sample mangler", 96, 12, 300, 24, juce::Justification::left);
}

void HazenManglerEditor::resized() {
  auto area = getLocalBounds().reduced(16);
  area.removeFromTop(40);

  dropHint_.setBounds(area.removeFromBottom(24));
  reverse_.setBounds(area.removeFromBottom(28).withWidth(120));

  const int count = 5;
  const int w = area.getWidth() / count;
  juce::Slider* knobs[count] = {&bits_, &rate_, &drive_, &verbMix_, &verbSize_};
  juce::Label* labels[count] = {&bitsLabel_, &rateLabel_, &driveLabel_,
                                &verbMixLabel_, &verbSizeLabel_};
  for (int i = 0; i < count; ++i) {
    auto cell = area.removeFromLeft(w).reduced(4);
    labels[i]->setBounds(cell.removeFromBottom(16));
    knobs[i]->setBounds(cell);
  }
}

bool HazenManglerEditor::isInterestedInFileDrag(const juce::StringArray& files) {
  for (const auto& f : files) {
    // Deliberately wide. A file the host will not even offer is worse than one
    // that fails with a message, which is the same lesson the web build learnt.
    if (f.endsWithIgnoreCase(".wav") || f.endsWithIgnoreCase(".aif") ||
        f.endsWithIgnoreCase(".aiff") || f.endsWithIgnoreCase(".mp3") ||
        f.endsWithIgnoreCase(".flac") || f.endsWithIgnoreCase(".m4a") ||
        f.endsWithIgnoreCase(".caf"))
      return true;
  }
  return false;
}

void HazenManglerEditor::filesDropped(const juce::StringArray& files, int, int) {
  if (files.isEmpty()) return;
  const juce::File file{files[0]};
  if (processor_.loadSample(file)) {
    dropHint_.setText(file.getFileName(), juce::dontSendNotification);
  } else {
    dropHint_.setText("could not read that one", juce::dontSendNotification);
  }
}
