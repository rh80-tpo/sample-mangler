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
const juce::String kPlayGlyph = juce::String::fromUTF8("\xe2\x96\xb6  play");  // ▶
const juce::String kStopGlyph = juce::String::fromUTF8("\xe2\x96\xa0  stop");  // ■
const juce::String kDragGlyph = juce::String::fromUTF8("\xe2\x87\xb1  drag to a track");  // ⇱

/// Chop tints. Four, separated by lightness rather than hue, for the same reason
/// the web build's are: a warm hue ramp at constant lightness collapses to one
/// colour under red-green colour blindness.
const juce::Colour kTints[4] = {
    juce::Colour::fromHSL(8.0f / 360.0f, 0.90f, 0.34f, 1.0f),
    juce::Colour::fromHSL(22.0f / 360.0f, 0.86f, 0.50f, 1.0f),
    juce::Colour::fromHSL(36.0f / 360.0f, 0.84f, 0.66f, 1.0f),
    juce::Colour::fromHSL(48.0f / 360.0f, 0.82f, 0.82f, 1.0f),
};

/// One knob column. Every dial in the interface is this wide, so they are all
/// the same size; the earlier build's rack knobs were two thirds the size of
/// the sidechain's because each module divided its own box by its knob count.
constexpr int kCell = 68;

juce::Font mono(float size, bool bold = false) {
  return juce::Font{juce::FontOptions{juce::Font::getDefaultMonospacedFontName(), size,
                                      bold ? juce::Font::bold : juce::Font::plain}};
}

/// Section chrome: a titled box. Returns the space left inside it.
juce::Rectangle<int> panel(juce::Graphics& g, juce::Rectangle<int> area,
                           const juce::String& title, bool lit = true) {
  const auto r = area.toFloat();
  // A shallow vertical gradient and a single bright top edge. This is the whole
  // trick behind panels that look moulded rather than drawn: light appears to
  // come from above, so a flat rectangle reads as a raised surface.
  g.setGradientFill(juce::ColourGradient{kRaised.brighter(0.05f), r.getCentreX(), r.getY(),
                                         kRaised.darker(0.22f), r.getCentreX(), r.getBottom(),
                                         false});
  g.fillRoundedRectangle(r, 4.0f);
  g.setColour(kInk.withAlpha(0.055f));
  g.drawLine(r.getX() + 3.0f, r.getY() + 0.5f, r.getRight() - 3.0f, r.getY() + 0.5f, 1.0f);
  g.setColour(kHairline);
  g.drawRoundedRectangle(r.reduced(0.5f), 4.0f, 1.0f);
  auto inner = area.reduced(10, 8);
  if (title.isNotEmpty()) {
    g.setColour(lit ? kSignal : kInkFaint);
    g.setFont(mono(9.5f, true));
    g.drawText(title.toUpperCase(), inner.removeFromTop(12), juce::Justification::topLeft);
    inner.removeFromTop(2);
  }
  return inner;
}

/// The face: dials, switches, buttons and menus, all in the same hand.
class KnobLook : public juce::LookAndFeel_V4 {
 public:
  KnobLook() {
    setColour(juce::Slider::textBoxTextColourId, kInk);
    setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    setColour(juce::Slider::textBoxBackgroundColourId, juce::Colours::transparentBlack);
    setColour(juce::Slider::textBoxHighlightColourId, kSignal.withAlpha(0.4f));
    setColour(juce::ComboBox::backgroundColourId, kSunken);
    setColour(juce::ComboBox::textColourId, kInk);
    setColour(juce::ComboBox::outlineColourId, kHairlineStrong);
    setColour(juce::ComboBox::arrowColourId, kSignal);
    setColour(juce::ComboBox::focusedOutlineColourId, kSignal.withAlpha(0.6f));
    setColour(juce::PopupMenu::backgroundColourId, kRaised);
    setColour(juce::PopupMenu::textColourId, kInk);
    setColour(juce::PopupMenu::highlightedBackgroundColourId, kSignal);
    setColour(juce::PopupMenu::highlightedTextColourId, kGround);
    setColour(juce::TextButton::buttonColourId, kSunken);
    setColour(juce::TextButton::buttonOnColourId, kSignal);
    setColour(juce::TextButton::textColourOffId, kInk);
    setColour(juce::TextButton::textColourOnId, kGround);
    setColour(juce::ToggleButton::textColourId, kInkDim);
    setColour(juce::ToggleButton::tickColourId, kSignal);
    setColour(juce::ToggleButton::tickDisabledColourId, kHairlineStrong);
    setColour(juce::TooltipWindow::backgroundColourId, kInk);
    setColour(juce::TooltipWindow::textColourId, kGround);
    setColour(juce::TooltipWindow::outlineColourId, juce::Colours::transparentBlack);
    setColour(juce::Label::textWhenEditingColourId, kInk);
    setColour(juce::TextEditor::highlightColourId, kSignal.withAlpha(0.4f));
    setColour(juce::TextEditor::focusedOutlineColourId, kSignal);
  }

  // One typeface everywhere. The stock look set buttons and menus in the system
  // sans, so half the face was in a different voice from the other half.
  juce::Font getTextButtonFont(juce::TextButton&, int height) override {
    return mono(juce::jmin(13.0f, height * 0.42f), true);
  }
  juce::Font getComboBoxFont(juce::ComboBox&) override { return mono(12.0f); }
  juce::Font getPopupMenuFont() override { return mono(12.0f); }
  juce::Font getLabelFont(juce::Label& l) override { return l.getFont(); }
  juce::Font getSliderPopupFont(juce::Slider&) override { return mono(11.0f); }

  static juce::TextLayout tipLayout(const juce::String& text) {
    juce::AttributedString a;
    a.setJustification(juce::Justification::centredLeft);
    a.append(text, mono(11.0f), kGround);
    juce::TextLayout layout;
    layout.createLayoutWithBalancedLineLengths(a, 300.0f);
    return layout;
  }
  juce::Rectangle<int> getTooltipBounds(const juce::String& text, juce::Point<int> pos,
                                        juce::Rectangle<int> parent) override {
    const juce::TextLayout layout = tipLayout(text);
    const int w = int(layout.getWidth() + 16.0f), h = int(layout.getHeight() + 10.0f);
    // Below the pointer and clamped to the window, so a tip on the bottom row
    // does not vanish off the edge.
    return juce::Rectangle<int>{pos.x > parent.getCentreX() ? pos.x - w : pos.x,
                                pos.y + 18 + h > parent.getBottom() ? pos.y - h - 6 : pos.y + 18,
                                w, h}
        .constrainedWithin(parent);
  }
  void drawTooltip(juce::Graphics& g, const juce::String& text, int w, int h) override {
    g.setColour(kInk);
    g.fillRoundedRectangle(juce::Rectangle<float>{0.0f, 0.0f, float(w), float(h)}, 3.0f);
    tipLayout(text).draw(g, juce::Rectangle<float>{8.0f, 5.0f, float(w) - 16.0f, float(h) - 10.0f});
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

    // Bipolar dials (pitch) fill from the centre, so zero reads as zero.
    const bool bipolar = s.getMinimum() < 0.0 && s.getMaximum() > 0.0;
    const float zero = bipolar ? startAngle + float((0.0 - s.getMinimum()) /
                                                   (s.getMaximum() - s.getMinimum())) *
                                                 (endAngle - startAngle)
                               : startAngle;
    if (std::abs(angle - zero) > 0.01f) {
      juce::Path fill;
      fill.addCentredArc(centre.x, centre.y, radius - ring, radius - ring, 0.0f,
                         juce::jmin(zero, angle), juce::jmax(zero, angle), true);
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
    const bool live = b.isEnabled();
    const auto base = colour.withMultipliedBrightness(down ? 0.86f : hover && live ? 1.12f : 1.0f)
                          .withMultipliedAlpha(live ? 1.0f : 0.45f);
    g.setColour(juce::Colours::black.withAlpha(live ? 0.35f : 0.15f));
    g.fillRoundedRectangle(r.translated(0.0f, 1.0f), 4.0f);
    g.setGradientFill(juce::ColourGradient{base.brighter(0.10f), r.getCentreX(), r.getY(),
                                           base.darker(0.14f), r.getCentreX(), r.getBottom(),
                                           false});
    g.fillRoundedRectangle(r, 4.0f);
    // The signal-coloured buttons get a glow; it is what marks them as the
    // thing to press.
    if (colour == kSignal && live) {
      g.setColour(kSignal.withAlpha(hover ? 0.35f : 0.18f));
      g.drawRoundedRectangle(r.expanded(1.5f), 5.0f, 2.0f);
    }
    g.setColour(kInk.withAlpha(live ? 0.14f : 0.06f));
    g.drawRoundedRectangle(r, 4.0f, 1.0f);
  }

  void drawButtonText(juce::Graphics& g, juce::TextButton& b, bool, bool) override {
    g.setFont(getTextButtonFont(b, b.getHeight()));
    const auto colour = b.findColour(b.getToggleState() ? juce::TextButton::textColourOnId
                                                        : juce::TextButton::textColourOffId);
    g.setColour(colour.withMultipliedAlpha(b.isEnabled() ? 1.0f : 0.5f));
    g.drawText(b.getButtonText(), b.getLocalBounds().reduced(4, 0), juce::Justification::centred,
               false);
  }

  /// A switch is a lamp and a name. Click anywhere on the name. The stock tick
  /// box was 16px wide and the word next to it did nothing.
  void drawToggleButton(juce::Graphics& g, juce::ToggleButton& b, bool hover, bool) override {
    const bool on = b.getToggleState();
    const bool live = b.isEnabled();
    auto r = b.getLocalBounds().toFloat();
    const float d = 9.0f;
    const auto lamp = juce::Rectangle<float>{d, d}.withCentre({r.getX() + 4.0f + d / 2.0f, r.getCentreY()});
    if (on) {
      g.setColour(kSignal.withAlpha(live ? 0.30f : 0.12f));
      g.fillEllipse(lamp.expanded(3.0f));
      g.setColour(live ? kSignal : kSignal.withAlpha(0.4f));
      g.fillEllipse(lamp);
      g.setColour(juce::Colours::white.withAlpha(0.35f));
      g.fillEllipse(lamp.reduced(2.5f).translated(-0.5f, -0.8f));
    } else {
      g.setColour(kSunken);
      g.fillEllipse(lamp);
      g.setColour(kInk.withAlpha(hover && live ? 0.45f : 0.22f));
      g.drawEllipse(lamp, 1.0f);
    }
    g.setFont(mono(9.5f, true));
    g.setColour(on ? kInk : hover && live ? kInkDim.brighter(0.3f) : kInkDim);
    if (!live) g.setColour(kInkFaint);
    g.drawText(b.getButtonText().toUpperCase(), r.withTrimmedLeft(d + 12.0f).toNearestInt(),
               juce::Justification::centredLeft, false);
  }

  void drawComboBox(juce::Graphics& g, int w, int h, bool, int, int, int, int,
                    juce::ComboBox& box) override {
    const auto r = juce::Rectangle<float>{0.0f, 0.0f, float(w), float(h)}.reduced(0.5f);
    g.setColour(kSunken);
    g.fillRoundedRectangle(r, 3.0f);
    g.setColour(box.hasKeyboardFocus(true) ? kSignal.withAlpha(0.6f) : kHairlineStrong);
    g.drawRoundedRectangle(r, 3.0f, 1.0f);
    // Chevron, small. The stock arrow took a third of the box.
    juce::Path chevron;
    const float cx = float(w) - 12.0f, cy = float(h) * 0.5f;
    chevron.startNewSubPath(cx - 4.0f, cy - 2.0f);
    chevron.lineTo(cx, cy + 2.0f);
    chevron.lineTo(cx + 4.0f, cy - 2.0f);
    g.setColour(box.isEnabled() ? kSignal : kInkFaint);
    g.strokePath(chevron, juce::PathStrokeType{1.5f});
  }
  void positionComboBoxText(juce::ComboBox& box, juce::Label& label) override {
    label.setBounds(6, 1, box.getWidth() - 26, box.getHeight() - 2);
    label.setFont(getComboBoxFont(box));
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

  subtitle.setText("a midi note plays it" + kDot + "drop a file anywhere", juce::dontSendNotification);
  subtitle.setFont(mono(9.5f));
  subtitle.setColour(juce::Label::textColourId, kInkFaint);
  addAndMakeVisible(subtitle);

  statusLabel.setFont(mono(10.5f));
  statusLabel.setColour(juce::Label::textColourId, kInkDim);
  statusLabel.setJustificationType(juce::Justification::centredRight);
  addAndMakeVisible(statusLabel);

  gridLabel.setFont(mono(9.5f));
  gridLabel.setColour(juce::Label::textColourId, kInkFaint);
  gridLabel.setJustificationType(juce::Justification::centredLeft);
  addAndMakeVisible(gridLabel);

  rollLabel.setFont(mono(10.0f));
  rollLabel.setColour(juce::Label::textColourId, kInkDim);
  rollLabel.setJustificationType(juce::Justification::centred);
  addAndMakeVisible(rollLabel);

  // --- the deck: the five things you do, in the order you do them ---------
  styleAction(loadButton, false, "Open a file. Dropping one anywhere on this window works too.");
  loadButton.onClick = [this] {
    chooser = std::make_unique<juce::FileChooser>(
        "Load a sample", juce::File{},
        // Video containers included on purpose: taking the audio out of an mp4
        // is a normal thing to want, and CoreAudio reads the audio track of one
        // directly. Not being able to pick the file is a worse failure than
        // picking it and being told why it did not work.
        "*.wav;*.aif;*.aiff;*.mp3;*.flac;*.m4a;*.caf;*.ogg;*.aac;*.mp4;*.m4v;*.mov;*.3gp;*.m4b");
    chooser->launchAsync(juce::FileBrowserComponent::openMode |
                             juce::FileBrowserComponent::canSelectFiles,
                         [this](const juce::FileChooser& fc) {
                           const auto file = fc.getResult();
                           if (file.existsAsFile()) processor.loadSample(file);
                         });
  };

  // One button, two states. Play and stop as separate buttons meant one of them
  // was always greyed out, and which one was the thing you had to work out.
  styleAction(playButton, false,
              "Play the loop from the top. A MIDI note does the same, and stops on note-off.");
  playButton.onClick = [this] {
    if (processor.isPlaying()) processor.stopPlayback();
    else processor.startPlayback();
  };

  // Mode as two tabs rather than a menu: one click, and both options stay in
  // view so you can see there is another one.
  for (auto* t : {&mangleTab, &chopTab}) {
    t->setClickingTogglesState(true);
    t->setRadioGroupId(1001);
    addAndMakeVisible(t);
  }
  mangleTab.setTooltip("Run the whole sample through the rack and fit it to a bar count.");
  chopTab.setTooltip("Cut it into a rhythm on the grid, then run the rack over each phrase.");
  mangleTab.onClick = [this] { setMode(0); };
  chopTab.onClick = [this] { setMode(1); };

  styleAction(rerollButton, true, "Roll a new random rack. The arrows step back through earlier rolls.");
  rerollButton.onClick = [this] { processor.reroll(); };

  // The chopper's own two actions. Without a rechop the rhythm was seeded and
  // every chop of a given setup came out identical, with no way to ask for
  // another take.
  styleAction(rechopButton, false, "A new performance of the same settings.");
  styleAction(chopMangleButton, true, "A new chop and a new random rack, in one press.");
  rechopButton.onClick = [this] { processor.rechop(); };
  chopMangleButton.onClick = [this] { processor.chopAndMangle(); };

  for (auto* b : {&rollBack, &rollForward}) {
    styleAction(*b, false, {});
    b->setConnectedEdges(juce::Button::ConnectedOnLeft | juce::Button::ConnectedOnRight);
  }
  rollBack.setTooltip("Back to the previous roll.");
  rollForward.setTooltip("Forward to the next roll.");
  rollBack.onClick = [this] { processor.stepRoll(-1); };
  rollForward.onClick = [this] { processor.stepRoll(1); };

  styleAction(exportButton, false, "Save the loop as a 24-bit WAV.");
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
  dragOut.setTooltip("Drag this onto an audio track. It lands as a WAV, kept in Music/HAZEN Sampler "
                     "so the clip keeps working. Every take gets its own file.");
  addAndMakeVisible(dragOut);

  // --- settings --------------------------------------------------------
  addChoice(bars, "bars", "bars", {"1", "2", "4", "8", "16"}, "How long the loop comes out.");
  addChoice(pattern, "pattern", "pattern", {"AAAB", "ABAB", "AABA", "ABAC", "AAAA", "ABCB"},
            "How the phrases are arranged. Each letter is one phrase.");
  addChoice(length, "length", "length", {"4 bars", "8 bars", "16 bars"}, "Total length of the loop.");
  addChoice(cut, "cut", "cut", {"transients", "1/1", "1/2", "1/4", "1/8", "1/16"},
            "Where the slices are cut: on the sound's own transients, or on a note grid.");
  addChoice(res, "res", "grid", {"1/8", "1/16"}, "The rhythmic grid the slices are placed on.");
  addChoice(duckRate, "duckrate", "kick", {"1/1", "1/2", "1/4", "1/8"}, "How often the kick hits.");

  addSwitch(sync, "sync", "sync", "Follow the host's tempo. Off, the bpm knob is the grid.");
  addSwitch(rackOn, "rackon", "effects", "Run the rack over the chop. Off, you hear the chop dry.");
  addSwitch(reverseOn, "revon", "01 reverse", "Play it backwards.");
  addSwitch(chopOn, "chopon", "02 chop", "Slice it up and shuffle the pieces.");
  addSwitch(pitchOn, "pitchon", "03 pitch", "Shift the pitch without changing the length.");
  addSwitch(crushOn, "crushon", "04 crush", "Fewer bits, lower rate.");
  addSwitch(driveOn, "driveon", "05 drive", "Saturate it.");
  addSwitch(verbOn, "verbon", "06 verb", "Reverb.");

  addKnob(tempo, "tempo", "bpm", Unit::Integer, "The grid, when sync is off.");
  addKnob(segments, "segments", "slices", Unit::Integer, "How many pieces to cut it into.");
  addKnob(scatter, "scatter", "scatter", Unit::Percent, "How far the pieces move from where they were.");
  addKnob(stutter, "stutter", "stutter", Unit::Percent, "How often a piece repeats.");
  addKnob(gate, "gate", "gate", Unit::Percent, "How many pieces are dropped to silence.");
  addKnob(bits, "bits", "bits", Unit::Integer, "Bit depth.");
  addKnob(divisor, "divisor", "rate", Unit::Integer, "Sample-rate divider.");
  addKnob(semitones, "semitones", "pitch", Unit::Semitones, "Semitones up or down.");
  addKnob(grain, "grain", "grain", Unit::Millis, "Grain size. Small is smoother, large is more metallic.");
  addKnob(drive, "drive", "drive", Unit::Percent, "How hard.");
  addKnob(verbSize, "verbsize", "size", Unit::Percent, "Room size.");
  addKnob(verbDamp, "verbdamp", "damp", Unit::Hertz, "Where the highs roll off in the tail.");
  addKnob(verbMix, "verbmix", "mix", Unit::Percent, "Dry to wet.");
  addKnob(density, "density", "density", Unit::Percent, "How much of the grid gets a hit.");
  addKnob(variation, "variation", "variation", Unit::Percent, "How different the phrases are from each other.");
  addKnob(hold, "hold", "hold", Unit::Percent, "How far a slice rings past its own slot.");
  addKnob(duck, "duck", "duck", Unit::Percent, "Sidechain to a kick. Zero is off.");
  addKnob(duckRelease, "duckrel", "release", Unit::Percent, "How fast it comes back up after each kick.");
  addKnob(level, "level", "level", Unit::Decibels, "Output level.");

  // The rack, as modules. Order matches the chain the processor runs.
  modules = {
      {&reverseOn, {}, {}},
      {&chopOn, {&segments, &scatter, &stutter, &gate}, {}},
      {&pitchOn, {&semitones, &grain}, {}},
      {&crushOn, {&bits, &divisor}, {}},
      {&driveOn, {&drive}, {}},
      {&verbOn, {&verbSize, &verbDamp, &verbMix}, {}},
  };

  applyMode();
  // Fits a laptop. The earlier 920 by 792 was taller than the space Live gives
  // a plugin window on a 13-inch screen, and the bottom row was the one that
  // got cut off.
  setSize(960, 596);
  startTimerHz(20);
}

HazenSamplerEditor::~HazenSamplerEditor() { setLookAndFeel(nullptr); }

bool HazenSamplerEditor::chopMode() const {
  return juce::roundToInt(processor.params.getRawParameterValue("mode")->load()) == 1;
}

void HazenSamplerEditor::setMode(int index) {
  if (auto* prm = processor.params.getParameter("mode")) {
    prm->beginChangeGesture();
    prm->setValueNotifyingHost(prm->convertTo0to1(float(index)));
    prm->endChangeGesture();
  }
  applyMode();
  processor.invalidate();
}

void HazenSamplerEditor::styleAction(juce::TextButton& b, bool primary, const juce::String& tip) {
  b.setColour(juce::TextButton::buttonColourId, primary ? kSignal : kSunken);
  b.setColour(juce::TextButton::textColourOffId, primary ? kGround : kInk);
  if (tip.isNotEmpty()) b.setTooltip(tip);
  addAndMakeVisible(b);
}

void HazenSamplerEditor::addKnob(Knob& k, const juce::String& id, const juce::String& caption,
                                 Unit unit, const juce::String& tip) {
  k.slider.setName(caption);
  k.slider.setSliderStyle(juce::Slider::RotaryVerticalDrag);
  k.slider.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 60, 14);
  k.slider.setColour(juce::Slider::textBoxTextColourId, kInk);
  k.slider.setTooltip(tip);
  k.slider.onValueChange = [this] { processor.invalidate(); };
  addAndMakeVisible(k.slider);

  k.caption.setText(caption, juce::dontSendNotification);
  k.caption.setFont(mono(9.0f));
  k.caption.setJustificationType(juce::Justification::centredTop);
  k.caption.setColour(juce::Label::textColourId, kInkFaint);
  addAndMakeVisible(k.caption);

  k.attach = std::make_unique<SliderAttach>(processor.params, id, k.slider);

  // Double-click puts a dial back where it started. Every plugin does this and
  // hands expect it; without it the only way back to "pitch 0" was typing it.
  if (auto* prm = processor.params.getParameter(id)) {
    k.slider.setDoubleClickReturnValue(true, prm->convertFrom0to1(prm->getDefaultValue()));
  }

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
  k.slider.valueFromTextFunction = [unit](const juce::String& t) {
    const double v = t.retainCharacters("0123456789.-+").getDoubleValue();
    switch (unit) {
      case Unit::Percent: return v / 100.0;
      case Unit::Millis: return v / 1000.0;
      case Unit::Hertz: return t.containsIgnoreCase("k") ? v * 1000.0 : v;
      case Unit::Integer:
      case Unit::Semitones:
      case Unit::Decibels: return v;
    }
    return v;
  };
  k.slider.updateText();
}

void HazenSamplerEditor::addSwitch(Switch& s, const juce::String& id, const juce::String& text,
                                   const juce::String& tip) {
  s.button.setButtonText(text);
  s.button.setTooltip(tip);
  s.button.onClick = [this] { processor.invalidate(); };
  addAndMakeVisible(s.button);
  s.attach = std::make_unique<ButtonAttach>(processor.params, id, s.button);
}

void HazenSamplerEditor::addChoice(Choice& c, const juce::String& id, const juce::String& caption,
                                   const juce::StringArray& options, const juce::String& tip) {
  c.box.addItemList(options, 1);
  c.box.setTooltip(tip);
  c.box.onChange = [this] { processor.invalidate(); };
  addAndMakeVisible(c.box);

  c.caption.setText(caption, juce::dontSendNotification);
  c.caption.setFont(mono(9.0f));
  c.caption.setColour(juce::Label::textColourId, kInkFaint);
  addAndMakeVisible(c.caption);

  c.attach = std::make_unique<ComboAttach>(processor.params, id, c.box);
}

void HazenSamplerEditor::applyMode() {
  const bool chop = chopMode();
  shownMode = chop ? 1 : 0;
  mangleTab.setToggleState(!chop, juce::dontSendNotification);
  chopTab.setToggleState(chop, juce::dontSendNotification);

  // Mangle-only.
  bars.box.setVisible(!chop);
  bars.caption.setVisible(!chop);
  rerollButton.setVisible(!chop);
  rollBack.setVisible(!chop);
  rollForward.setVisible(!chop);
  rollLabel.setVisible(!chop);

  // Chop-only. The rack itself stays: it runs in both modes, so it is shown in
  // both, with a master switch in chop mode.
  rechopButton.setVisible(chop);
  chopMangleButton.setVisible(chop);
  rackOn.button.setVisible(chop);
  for (auto* c : {&pattern, &length, &cut, &res}) {
    c->box.setVisible(chop);
    c->caption.setVisible(chop);
  }
  for (auto* k : {&density, &variation, &hold}) {
    k->slider.setVisible(chop);
    k->caption.setVisible(chop);
  }
  resized();
  repaint();
}

void HazenSamplerEditor::timerCallback() {
  // The mode can change from outside: a preset, host automation, the roll
  // history. Re-apply the layout when it has.
  if ((chopMode() ? 1 : 0) != shownMode) applyMode();

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

  const bool synced = sync.button.getToggleState();
  gridLabel.setText((synced ? "host" + kDot : juce::String{}) +
                        juce::String(juce::roundToInt(processor.tempo())) + " bpm",
                    juce::dontSendNotification);
  tempo.slider.setEnabled(!synced);

  const int count = processor.rollCount();
  rollLabel.setText(count > 0 ? juce::String(processor.rollIndex() + 1) + "/" + juce::String(count)
                              : juce::String("0/0"),
                    juce::dontSendNotification);
  rollBack.setEnabled(processor.rollIndex() > 0);
  rollForward.setEnabled(count > 0 && processor.rollIndex() < count - 1);

  const bool ready = processor.renderedSeconds() > 0.0;
  const bool playing = processor.isPlaying();
  // Until something is loaded, load is the only move, so it is the lit one.
  const bool empty = !processor.hasSample();
  loadButton.setColour(juce::TextButton::buttonColourId, empty ? kSignal : kSunken);
  loadButton.setColour(juce::TextButton::textColourOffId, empty ? kGround : kInk);
  playButton.setEnabled(ready);
  playButton.setButtonText(playing ? kStopGlyph : kPlayGlyph);
  playButton.setColour(juce::TextButton::buttonColourId, playing ? kSignal : kSunken);
  playButton.setColour(juce::TextButton::textColourOffId, playing ? kGround : kInk);
  exportButton.setEnabled(ready);
  rerollButton.setEnabled(processor.hasSample());
  rechopButton.setEnabled(processor.hasSample());
  chopMangleButton.setEnabled(processor.hasSample());
  dragOut.repaint();

  // In chop mode with the rack off, the modules are still there to set up, but
  // they read as dormant.
  const bool rackLive = !chopMode() || rackOn.button.getToggleState();
  for (auto& m : modules)
    for (auto* k : m.knobs) k->slider.setEnabled(rackLive);

  repaint(waveArea);
}

void HazenSamplerEditor::paint(juce::Graphics& g) {
  g.fillAll(kGround);
  g.setColour(juce::Colour{0x0dede7dc});
  for (int x = 0; x < getWidth(); x += 44) g.drawVerticalLine(x, 0.0f, float(getHeight()));

  g.setColour(kSignal);
  g.setFont(mono(17.0f, true));
  g.drawText("HAZEN", 16, 12, 76, 22, juce::Justification::left);

  // --- waveform -------------------------------------------------------
  {
    const auto r = waveArea.toFloat();
    // Sunken, not raised: dark at the top edge is what reads as recessed, and the
    // waveform should look inset into the face rather than sitting on it.
    g.setGradientFill(juce::ColourGradient{kSunken.darker(0.5f), r.getCentreX(), r.getY(),
                                           kSunken, r.getCentreX(), r.getBottom(), false});
    g.fillRoundedRectangle(r, 4.0f);
    g.setColour(juce::Colours::black.withAlpha(0.55f));
    g.drawLine(r.getX() + 3.0f, r.getY() + 0.5f, r.getRight() - 3.0f, r.getY() + 0.5f, 1.0f);
    g.setColour(kHairline);
    g.drawRoundedRectangle(r.reduced(0.5f), 4.0f, 1.0f);
  }

  if (wave.empty()) {
    g.setColour(processor.hasSample() ? kInkDim : kInkFaint);
    g.setFont(mono(12.0f, true));
    auto text = waveArea;
    if (processor.hasSample()) {
      g.drawText("rendering", text, juce::Justification::centred);
    } else {
      g.drawText("drop audio or video here", text.removeFromTop(waveArea.getHeight() / 2 + 8),
                 juce::Justification::centredBottom);
      g.setFont(mono(10.0f));
      g.drawText("or press load" + kDot + "an mp4 gives up its audio track", text.withTrimmedTop(4),
                 juce::Justification::centredTop);
    }
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

  // A file over the window: say where it will land.
  if (dropping) {
    const auto r = waveArea.toFloat().reduced(2.0f);
    g.setColour(kSignal.withAlpha(0.10f));
    g.fillRoundedRectangle(r, 4.0f);
    juce::Path border, dashed;
    border.addRoundedRectangle(r, 4.0f);
    const float dashes[] = {6.0f, 4.0f};
    juce::PathStrokeType{1.5f}.createDashedStroke(dashed, border, dashes, 2);
    g.setColour(kSignal);
    g.fillPath(dashed);
    g.setFont(mono(12.0f, true));
    g.drawText("drop to load", waveArea, juce::Justification::centred);
  }

  // --- the deck ----------------------------------------------------------
  panel(g, deckArea, {});
  {
    // Hairline dividers between the groups, so the row reads as
    // load/play | mode | roll | out rather than nine buttons.
    g.setColour(kHairlineStrong);
    const int y0 = deckArea.getY() + 10, y1 = deckArea.getBottom() - 10;
    const int afterPlay = playButton.getRight() + 14;
    const int afterMode = chopTab.getRight() + 14;
    g.drawVerticalLine(afterPlay, float(y0), float(y1));
    g.drawVerticalLine(afterMode, float(y0), float(y1));
    g.drawVerticalLine(exportButton.getX() - 14, float(y0), float(y1));
  }

  // --- settings ----------------------------------------------------------
  panel(g, settingsArea, chopMode() ? "chop" : "grid");

  // --- rack ----------------------------------------------------------------
  const bool chop = chopMode();
  const bool rackLive = !chop || rackOn.button.getToggleState();
  g.setColour(rackLive ? kSignal : kInkFaint);
  g.setFont(mono(9.5f, true));
  g.drawText(chop ? "RACK" + kDot + "OVER EACH PHRASE" : "RACK", rackTitle, juce::Justification::centredLeft);
  for (const auto& m : modules) {
    if (m.bounds.isEmpty()) continue;
    const bool on = m.power && m.power->button.getToggleState();
    const auto r = m.bounds.toFloat();
    g.setGradientFill(juce::ColourGradient{kRaised.brighter(on && rackLive ? 0.08f : 0.03f),
                                           r.getCentreX(), r.getY(), kRaised.darker(0.22f),
                                           r.getCentreX(), r.getBottom(), false});
    g.fillRoundedRectangle(r, 4.0f);
    g.setColour(on && rackLive ? kSignal.withAlpha(0.35f) : kHairline);
    g.drawRoundedRectangle(r.reduced(0.5f), 4.0f, 1.0f);
  }

  panel(g, sideArea, "sidechain");
  panel(g, outArea, "out");
}

void HazenSamplerEditor::placeKnobs(juce::Rectangle<int> area, const std::vector<Knob*>& knobs) {
  for (auto* k : knobs) {
    auto slot = area.removeFromLeft(kCell);
    // Caption below the dial's own value box, so nothing overlaps.
    k->caption.setBounds(slot.removeFromBottom(11));
    k->slider.setBounds(slot);
  }
}

void HazenSamplerEditor::placeChoice(juce::Rectangle<int> cell, Choice& c) {
  c.caption.setBounds(cell.removeFromTop(11));
  cell.removeFromTop(2);
  c.box.setBounds(cell.removeFromTop(24));
}

void HazenSamplerEditor::resized() {
  auto area = getLocalBounds().reduced(14);

  auto head = area.removeFromTop(26);
  title.setBounds(head.removeFromLeft(190).withTrimmedLeft(76));
  statusLabel.setBounds(head.removeFromRight(440));
  subtitle.setBounds(head);

  area.removeFromTop(6);
  waveArea = area.removeFromTop(104);
  area.removeFromTop(8);

  // The deck. Left to right is the order of use.
  deckArea = area.removeFromTop(48);
  {
    auto row = deckArea.reduced(10, 8);
    loadButton.setBounds(row.removeFromLeft(80));
    row.removeFromLeft(6);
    playButton.setBounds(row.removeFromLeft(104));
    row.removeFromLeft(28);
    mangleTab.setBounds(row.removeFromLeft(74));
    row.removeFromLeft(2);
    chopTab.setBounds(row.removeFromLeft(74));
    row.removeFromLeft(28);

    // Export sits next to the drag handle: same job, one for each habit.
    dragOut.setBounds(row.removeFromRight(160));
    row.removeFromRight(6);
    exportButton.setBounds(row.removeFromRight(100));
    row.removeFromRight(28);

    if (chopMode()) {
      rechopButton.setBounds(row.removeFromLeft(96));
      row.removeFromLeft(6);
      chopMangleButton.setBounds(row.removeFromLeft(154));
    } else {
      rerollButton.setBounds(row.removeFromLeft(112));
      row.removeFromLeft(10);
      // Roll history sits with reroll, since it is what reroll makes recoverable.
      rollBack.setBounds(row.removeFromLeft(28));
      rollLabel.setBounds(row.removeFromLeft(44));
      rollForward.setBounds(row.removeFromLeft(28));
    }
  }
  area.removeFromTop(8);

  // Settings for the mode: tempo always, then bars or the chop's shape. The
  // panel is as wide as what is in it. Stretched full width, mangle mode's
  // three controls sat in a box that was four fifths empty.
  settingsArea = area.removeFromTop(112);
  settingsArea.setWidth(chopMode() ? 20 + kCell + 6 + 74 + 18 + 4 * 108 + 14 + 3 * kCell + 12
                                   : 20 + kCell + 6 + 74 + 18 + 80);
  {
    auto inner = settingsArea.reduced(10, 8);
    inner.removeFromTop(14);
    placeKnobs(inner.removeFromLeft(kCell), {&tempo});
    inner.removeFromLeft(6);
    auto syncCell = inner.removeFromLeft(74);
    sync.button.setBounds(syncCell.removeFromTop(38).withTrimmedTop(8));
    gridLabel.setBounds(syncCell.withTrimmedLeft(4).removeFromTop(22));
    inner.removeFromLeft(18);

    if (chopMode()) {
      auto choices = inner.removeFromLeft(4 * 108).withTrimmedTop(6);
      placeChoice(choices.removeFromLeft(104), pattern);
      choices.removeFromLeft(4);
      placeChoice(choices.removeFromLeft(104), length);
      choices.removeFromLeft(4);
      placeChoice(choices.removeFromLeft(104), cut);
      choices.removeFromLeft(4);
      placeChoice(choices.removeFromLeft(104), res);
      inner.removeFromLeft(18);
      placeKnobs(inner.removeFromLeft(3 * kCell), {&density, &variation, &hold});
    } else {
      placeChoice(inner.removeFromLeft(80).withTrimmedTop(6), bars);
    }
  }
  area.removeFromTop(8);

  // The rack: six modules in two rows on the left, sidechain and out stacked on
  // the right, all in the same two row heights so the edges line up.
  rackArea = area;
  rackTitle = rackArea.removeFromTop(16);
  rackOn.button.setBounds(rackTitle.withX(rackTitle.getX() + 236).withWidth(90));
  rackArea.removeFromTop(4);
  const int rowH = (rackArea.getHeight() - 6) / 2;
  auto top = rackArea.removeFromTop(rowH);
  rackArea.removeFromTop(6);
  auto bottom = rackArea.removeFromTop(rowH);

  auto place = [](juce::Rectangle<int>& row, Module& m, int width) {
    m.bounds = row.removeFromLeft(width);
    row.removeFromLeft(6);
    auto inner = m.bounds.reduced(8, 6);
    // The switch is the whole header: click the module's name to turn it on.
    if (m.power) m.power->button.setBounds(inner.removeFromTop(18));
    inner.removeFromTop(2);
    if (!m.knobs.empty()) placeKnobs(inner, m.knobs);
  };
  // Widths from the knob count, then the bottom row stretched to the same
  // total so the right column starts on one straight edge.
  const int rackWidth = 96 + 6 + (16 + 4 * kCell) + 6 + (16 + 2 * kCell);
  place(top, modules[0], 96);
  place(top, modules[1], 16 + 4 * kCell);
  place(top, modules[2], 16 + 2 * kCell);
  place(bottom, modules[3], 16 + 2 * kCell + 24);
  place(bottom, modules[4], 16 + kCell + 28);
  place(bottom, modules[5], rackWidth - (16 + 2 * kCell + 24) - (16 + kCell + 28) - 12);

  const int rightX = deckArea.getX() + rackWidth + 10;
  sideArea = top.withLeft(rightX);
  outArea = bottom.withLeft(rightX);
  {
    auto inner = sideArea.reduced(10, 8);
    inner.removeFromTop(14);
    placeKnobs(inner.removeFromLeft(2 * kCell), {&duck, &duckRelease});
    inner.removeFromLeft(10);
    placeChoice(inner.removeFromLeft(84).withTrimmedTop(6), duckRate);
  }
  {
    auto inner = outArea.reduced(10, 8);
    inner.removeFromTop(14);
    placeKnobs(inner.removeFromLeft(kCell), {&level});
  }
}

void HazenSamplerEditor::DragOut::paint(juce::Graphics& g) {
  const auto r = getLocalBounds().toFloat().reduced(0.5f);
  const bool ready = editor.processor.renderedSeconds() > 0.0;
  g.setColour(kSunken.withAlpha(ready ? 1.0f : 0.5f));
  g.fillRoundedRectangle(r, 4.0f);
  // Dashed, so it reads as a place to grab from rather than a button to press.
  juce::Path border, dashed;
  border.addRoundedRectangle(r, 4.0f);
  const float dashes[] = {4.0f, 3.0f};
  juce::PathStrokeType{1.0f}.createDashedStroke(dashed, border, dashes, 2);
  g.setColour(ready ? (hover ? kSignal : kHairlineStrong) : kHairline);
  g.fillPath(dashed);

  g.setColour(ready ? (hover ? kSignal : kInkDim) : kInkFaint);
  g.setFont(mono(10.5f, true));
  g.drawText(ready ? kDragGlyph : "nothing to drag yet", getLocalBounds(),
             juce::Justification::centred);
}

void HazenSamplerEditor::DragOut::mouseDrag(const juce::MouseEvent& e) {
  if (dragging || e.getDistanceFromDragStart() < 6) return;
  if (editor.processor.renderedSeconds() <= 0.0) return;
  const auto file = editor.processor.writeDragFile();
  if (file == juce::File{}) return;
  dragging = true;
  // An external drag, so the destination is any app that takes files, which is
  // what puts it on an Ableton audio track in one gesture.
  juce::DragAndDropContainer::performExternalDragDropOfFiles(
      {file.getFullPathName()}, false, this, [this] { dragging = false; });
}

bool HazenSamplerEditor::isInterestedInFileDrag(const juce::StringArray& files) {
  for (const auto& f : files) {
    // Deliberately wide, and it includes video. A file the host refuses to even
    // offer is worse than one that fails with a message, the lesson the web
    // build learned from AIFF, and dropping an mp4 in for its audio is a normal
    // thing to do rather than a mistake to guard against.
    static const char* kTakes[] = {".wav", ".aif", ".aiff", ".mp3",  ".flac", ".m4a",
                                   ".caf", ".ogg", ".aac",  ".mp4",  ".m4v",  ".mov",
                                   ".3gp", ".m4b", ".au",   ".snd"};
    for (const auto* ext : kTakes) {
      if (f.endsWithIgnoreCase(ext)) return true;
    }
  }
  return false;
}

void HazenSamplerEditor::fileDragEnter(const juce::StringArray&, int, int) {
  dropping = true;
  repaint(waveArea);
}

void HazenSamplerEditor::fileDragExit(const juce::StringArray&) {
  dropping = false;
  repaint(waveArea);
}

void HazenSamplerEditor::filesDropped(const juce::StringArray& files, int, int) {
  dropping = false;
  repaint(waveArea);
  if (files.isEmpty()) return;
  processor.loadSample(juce::File{files[0]});
}
