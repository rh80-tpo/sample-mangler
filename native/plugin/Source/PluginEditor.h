#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "PluginProcessor.h"

/**
 * The editor. Same palette and typographic register as the web build, so the
 * two read as one product rather than as a port.
 */
class HazenSamplerEditor : public juce::AudioProcessorEditor,
                           public juce::FileDragAndDropTarget,
                           private juce::Timer {
 public:
  explicit HazenSamplerEditor(HazenSamplerProcessor&);
  ~HazenSamplerEditor() override = default;

  void paint(juce::Graphics&) override;
  void resized() override;

  bool isInterestedInFileDrag(const juce::StringArray&) override;
  void filesDropped(const juce::StringArray&, int, int) override;

 private:
  void timerCallback() override;

  using SliderAttach = juce::AudioProcessorValueTreeState::SliderAttachment;
  using ButtonAttach = juce::AudioProcessorValueTreeState::ButtonAttachment;
  using ComboAttach = juce::AudioProcessorValueTreeState::ComboBoxAttachment;

  /// A labelled rotary bound to one parameter.
  struct Knob {
    juce::Slider slider;
    juce::Label label;
    std::unique_ptr<SliderAttach> attach;
  };
  /// An on/off module header, so a whole effect can be bypassed like the rack.
  struct Toggle {
    juce::ToggleButton button;
    std::unique_ptr<ButtonAttach> attach;
  };
  struct Choice {
    juce::ComboBox box;
    juce::Label label;
    std::unique_ptr<ComboAttach> attach;
  };

  void addKnob(Knob&, const juce::String& id, const juce::String& text);
  void addToggle(Toggle&, const juce::String& id, const juce::String& text);
  void addChoice(Choice&, const juce::String& id, const juce::String& text,
                 const juce::StringArray& options);
  void layoutRow(juce::Rectangle<int> area, const juce::String& title,
                 std::vector<juce::Component*> items);

  HazenSamplerProcessor& processor;

  Choice mode, bars, pattern, length, cut, res, duckRate;
  Toggle sync, reverseOn, chopOn, crushOn, pitchOn, driveOn, verbOn;
  Knob segments, scatter, stutter, gate;
  Knob bits, divisor, semitones, grain, drive, verbSize, verbMix;
  Knob density, variation, hold;
  Knob duck, duckRelease, level;

  juce::TextButton loadButton{"load a sample"};
  juce::Label title, statusLabel, hint;
  std::unique_ptr<juce::FileChooser> chooser;

  std::vector<float> wave;
  float playhead = -1.0f;
  juce::Rectangle<int> waveArea;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HazenSamplerEditor)
};
