# HAZEN sample mangler — plugin build.
#
# NEVER COMPILED. Written from the JUCE API, but cmake, full Xcode and JUCE are
# all absent on the machine this was authored on, so treat it as a starting
# point. See ../README.md.

cmake_minimum_required(VERSION 3.22)
project(HazenMangler VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET 11.0)
# Universal, so it loads in both Intel and Apple Silicon hosts.
set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64")

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../JUCE ${CMAKE_BINARY_DIR}/JUCE)

juce_add_plugin(HazenMangler
    COMPANY_NAME "HAZEN"
    PLUGIN_MANUFACTURER_CODE Hzn1
    PLUGIN_CODE Hzm1
    FORMATS VST3 AU Standalone
    PRODUCT_NAME "HAZEN sample mangler"
    # It loads and plays samples rather than processing a live input, which is
    # the honest translation of a tool that renders offline. See README.
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    COPY_PLUGIN_AFTER_BUILD TRUE
)

target_sources(HazenMangler PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
)

target_include_directories(HazenMangler PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../include
)

target_compile_definitions(HazenMangler PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(HazenMangler PRIVATE
    juce::juce_audio_utils
    juce::juce_dsp
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)
