// NEVER COMPILED. See ../../README.md.

#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "PluginProcessor.h"

class HazenManglerEditor : public juce::AudioProcessorEditor,
                           public juce::FileDragAndDropTarget {
 public:
  explicit HazenManglerEditor(HazenManglerProcessor&);
  ~HazenManglerEditor() override = default;

  void paint(juce::Graphics&) override;
  void resized() override;

  bool isInterestedInFileDrag(const juce::StringArray& files) override;
  void filesDropped(const juce::StringArray& files, int x, int y) override;

 private:
  using Attachment = juce::AudioProcessorValueTreeState::SliderAttachment;
  using ButtonAttachment = juce::AudioProcessorValueTreeState::ButtonAttachment;

  void addKnob(juce::Slider&, juce::Label&, const juce::String& id,
               const juce::String& text, std::unique_ptr<Attachment>&);

  HazenManglerProcessor& processor_;

  juce::Slider bits_, rate_, drive_, verbMix_, verbSize_;
  juce::Label bitsLabel_, rateLabel_, driveLabel_, verbMixLabel_, verbSizeLabel_;
  juce::ToggleButton reverse_{"reverse"};
  juce::Label dropHint_;

  std::unique_ptr<Attachment> bitsAttach_, rateAttach_, driveAttach_,
      verbMixAttach_, verbSizeAttach_;
  std::unique_ptr<ButtonAttachment> reverseAttach_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(HazenManglerEditor)
};
