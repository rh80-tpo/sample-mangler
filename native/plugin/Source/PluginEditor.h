#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "PluginProcessor.h"

/**
 * The editor.
 *
 * Laid out as labelled sections in a column, the way the web build's rows are,
 * because the first version put toggles inline with knobs and let mode-specific
 * controls share the same rectangle. Nothing read as a module and half the
 * labels collided.
 *
 * Two rules came out of that:
 *   1. A module is a bordered box with its own title, its own switch, and only
 *      its own knobs. Grouping is the thing that makes a rack legible.
 *   2. Visibility is set by `applyMode()` from the constructor and from the mode
 *      control, never from the timer. A layout that only becomes correct once a
 *      timer has fired is a layout that is wrong when you screenshot it.
 */
class HazenSamplerEditor : public juce::AudioProcessorEditor,
                           public juce::FileDragAndDropTarget,
                           private juce::Timer {
 public:
  explicit HazenSamplerEditor(HazenSamplerProcessor&);
  ~HazenSamplerEditor() override;

  void paint(juce::Graphics&) override;
  void resized() override;

  bool isInterestedInFileDrag(const juce::StringArray&) override;
  void filesDropped(const juce::StringArray&, int, int) override;

 private:
  void timerCallback() override;
  void applyMode();
  bool chopMode() const;

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
    juce::String title;
    Switch* power = nullptr;
    std::vector<Knob*> knobs;
    juce::Rectangle<int> bounds;  ///< filled in by resized(), read by paint()
  };

  void addKnob(Knob&, const juce::String& id, const juce::String& caption, Unit);
  void addSwitch(Switch&, const juce::String& id, const juce::String& text);
  void addChoice(Choice&, const juce::String& id, const juce::String& caption,
                 const juce::StringArray& options);

  /// Lay a row of knobs out inside `area`, caption under each dial.
  static void placeKnobs(juce::Rectangle<int> area, const std::vector<Knob*>&);

  HazenSamplerProcessor& processor;

  Choice mode, bars, pattern, length, cut, res, duckRate;
  Switch sync, reverseOn, chopOn, crushOn, pitchOn, driveOn, verbOn;
  Knob tempo;
  Knob segments, scatter, stutter, gate;
  Knob bits, divisor, semitones, grain, drive, verbSize, verbDamp, verbMix;
  Knob density, variation, hold;
  Knob duck, duckRelease, level;

  juce::TextButton loadButton{"load a sample"};
  juce::TextButton rerollButton{"reroll"};
  juce::TextButton rollBack{"<"}, rollForward{">"};
  juce::Label title, subtitle, statusLabel, rollLabel, hint;
  std::unique_ptr<juce::FileChooser> chooser;

  std::vector<Module> mangleModules;
  std::vector<float> wave;
  std::vector<float> voiceAt;
  std::vector<int> voiceSlice;
  float playhead = -1.0f;

  juce::Rectangle<int> waveArea, sourceArea, transportArea, mangleArea, chopArea,
      feelArea, sideArea, outArea;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HazenSamplerEditor)
};
