#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "PluginProcessor.h"

/**
 * The editor.
 *
 * One row of actions in the order you use them: load, play, pick a mode, roll,
 * then export or drag the result onto a track. Everything below that row is a
 * setting. The earlier layout scattered those five actions across three
 * sections with "tempo" holding the reroll button, and the rack disappeared in
 * chop mode while still running, so "rechop + mangle" changed the sound with
 * nothing on screen to show what it had done or a way to turn it off.
 *
 * Rules kept from the earlier versions:
 *   1. A module is a bordered box with its own title, its own switch, and only
 *      its own knobs.
 *   2. Visibility is set by `applyMode()` from the constructor and from the
 *      mode control. The timer only polls for the mode being changed from
 *      outside (a preset, host automation) and re-applies it then.
 *   3. Same height in both modes. A window that resizes when you flip a switch
 *      is a window the host has to re-lay-out, and it looks broken.
 */
class HazenSamplerEditor : public juce::AudioProcessorEditor,
                           public juce::FileDragAndDropTarget,
                           public juce::DragAndDropContainer,
                           private juce::Timer {
 public:
  explicit HazenSamplerEditor(HazenSamplerProcessor&);
  ~HazenSamplerEditor() override;

  void paint(juce::Graphics&) override;
  void resized() override;

  bool isInterestedInFileDrag(const juce::StringArray&) override;
  void filesDropped(const juce::StringArray&, int, int) override;
  void fileDragEnter(const juce::StringArray&, int, int) override;
  void fileDragExit(const juce::StringArray&) override;

 private:
  void timerCallback() override;
  void applyMode();
  bool chopMode() const;
  void setMode(int index);

  using SliderAttach = juce::AudioProcessorValueTreeState::SliderAttachment;
  using ButtonAttach = juce::AudioProcessorValueTreeState::ButtonAttachment;
  using ComboAttach = juce::AudioProcessorValueTreeState::ComboBoxAttachment;

  /// How a knob's value should read on its face.
  enum class Unit { Percent, Integer, Semitones, Millis, Hertz, Decibels };

  struct Knob {
    juce::Slider slider;
    juce::Label caption;
    std::unique_ptr<SliderAttach> attach;
  };
  struct Switch {
    juce::ToggleButton button;
    std::unique_ptr<ButtonAttach> attach;
  };
  struct Choice {
    juce::ComboBox box;
    juce::Label caption;
    std::unique_ptr<ComboAttach> attach;
  };

  /// A rack module: one switch, its own knobs, its own bordered box.
  struct Module {
    Switch* power = nullptr;
    std::vector<Knob*> knobs;
    juce::Rectangle<int> bounds;  ///< filled in by resized(), read by paint()
  };

  void addKnob(Knob&, const juce::String& id, const juce::String& caption, Unit,
               const juce::String& tip);
  void addSwitch(Switch&, const juce::String& id, const juce::String& text,
                 const juce::String& tip);
  void addChoice(Choice&, const juce::String& id, const juce::String& caption,
                 const juce::StringArray& options, const juce::String& tip);
  void styleAction(juce::TextButton&, bool primary, const juce::String& tip);

  /// Lay a row of knobs out inside `area`, caption under each dial.
  static void placeKnobs(juce::Rectangle<int> area, const std::vector<Knob*>&);
  /// Lay a combo box with its caption above it.
  static void placeChoice(juce::Rectangle<int> cell, Choice&);

  HazenSamplerProcessor& processor;

  Choice bars, pattern, length, cut, res, duckRate;
  Switch sync, rackOn, reverseOn, chopOn, crushOn, pitchOn, driveOn, verbOn;
  Knob tempo;
  Knob segments, scatter, stutter, gate;
  Knob bits, divisor, semitones, grain, drive, verbSize, verbDamp, verbMix;
  Knob density, variation, hold;
  Knob duck, duckRelease, level;

  /**
   * Drag this into a host to get the audio as a file.
   *
   * The point of the whole plugin is producing a loop you then use, and the
   * shortest path from "it sounds right" to "it is on an audio track" is
   * dragging it there. One drag per gesture: mouseDrag fires on every pixel of
   * movement, and the first version wrote a fresh WAV and began a new native
   * drag session on each of them.
   */
  struct DragOut : public juce::Component, public juce::SettableTooltipClient {
    explicit DragOut(HazenSamplerEditor& owner) : editor(owner) {}
    void paint(juce::Graphics&) override;
    void mouseDown(const juce::MouseEvent&) override { dragging = false; }
    void mouseDrag(const juce::MouseEvent&) override;
    void mouseUp(const juce::MouseEvent&) override { dragging = false; }
    void mouseEnter(const juce::MouseEvent&) override { hover = true; repaint(); }
    void mouseExit(const juce::MouseEvent&) override { hover = false; repaint(); }
    HazenSamplerEditor& editor;
    bool hover = false;
    bool dragging = false;
  };

  juce::TextButton loadButton{"load"};
  juce::TextButton playButton{"play"};
  juce::TextButton mangleTab{"mangle"}, chopTab{"chop"};
  juce::TextButton rerollButton{"reroll"};
  juce::TextButton rechopButton{"rechop"};
  juce::TextButton chopMangleButton{"rechop + mangle"};
  juce::TextButton rollBack{"<"}, rollForward{">"};
  juce::TextButton exportButton{"export wav"};
  DragOut dragOut{*this};
  juce::Label title, subtitle, statusLabel, rollLabel, gridLabel;
  std::unique_ptr<juce::FileChooser> chooser;
  juce::TooltipWindow tips{this, 600};

  std::vector<Module> modules;
  std::vector<float> wave;
  std::vector<float> core;
  std::vector<float> voiceAt;
  std::vector<int> voiceSlice;
  float playhead = -1.0f;
  bool dropping = false;
  int shownMode = -1;

  juce::Rectangle<int> waveArea, deckArea, settingsArea, rackArea, rackTitle, sideArea, outArea;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HazenSamplerEditor)
};
