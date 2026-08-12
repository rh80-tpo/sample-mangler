cmake_minimum_required(VERSION 3.22)
project(HazenSampler VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "" FORCE)

# Universal where the toolchain can, so the same build loads in an Intel host.
set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "" FORCE)

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../vendor/JUCE JUCE)

# Standalone is built alongside the plugin formats deliberately: it is the only
# way to launch and verify the thing without a host, and it costs nothing.
#
# AU is not requested. This machine has the Command Line Tools but not a full
# Xcode, and JUCE's AU wrapper needs Xcode's AudioUnit tooling. VST3 needs
# neither and Ableton Live on macOS loads VST3, so that is the target. Saying so
# here is more use than a build that fails halfway with a confusing error.
juce_add_plugin(HazenSampler
    COMPANY_NAME "HAZEN"
    BUNDLE_ID "com.hazen.sampler"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD TRUE
    PLUGIN_MANUFACTURER_CODE Hazn
    PLUGIN_CODE Hzsm
    FORMATS VST3 Standalone
    PRODUCT_NAME "HAZEN Sampler")

target_sources(HazenSampler PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

target_compile_definitions(HazenSampler PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_STRICT_REFCOUNTEDPOINTER=1)

# The DSP core is the same header-only code the test harness compiles, so the
# plugin cannot drift from what was verified.
target_include_directories(HazenSampler PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../include)

target_link_libraries(HazenSampler PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_formats
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)

# A headless harness that drives the real processor: load a file, render, pull
# audio through processBlock. A bundle that loads is not the same as a plugin
# that makes sound, and this is the only way to tell the difference without a
# host.
juce_add_console_app(HazenHarness PRODUCT_NAME "hazen-harness")
target_sources(HazenHarness PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../harness/main.cpp
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)
target_compile_definitions(HazenHarness PRIVATE
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_STANDALONE_APPLICATION=1
    JucePlugin_Name="HAZEN Sampler"
    JucePlugin_IsSynth=1
    JucePlugin_WantsMidiInput=1
    JucePlugin_ProducesMidiOutput=0)
target_include_directories(HazenHarness PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../include
    ${CMAKE_CURRENT_SOURCE_DIR}/Source)
target_link_libraries(HazenHarness PRIVATE
    juce::juce_audio_utils juce::juce_audio_formats juce::juce_audio_processors
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

# Renders the editor to a PNG without a window, so the UI can be reviewed at all
# on a machine with no Screen Recording permission.
juce_add_console_app(HazenSnapshot PRODUCT_NAME "hazen-snapshot")
target_sources(HazenSnapshot PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../harness/snapshot.cpp
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)
target_compile_definitions(HazenSnapshot PRIVATE
    JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_STANDALONE_APPLICATION=1
    # Needed to pump the message loop by hand so Timer-driven state settles
    # before the snapshot is taken.
    JUCE_MODAL_LOOPS_PERMITTED=1
    JucePlugin_Name="HAZEN Sampler"
    JucePlugin_IsSynth=1
    JucePlugin_WantsMidiInput=1
    JucePlugin_ProducesMidiOutput=0)
target_include_directories(HazenSnapshot PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../include
    ${CMAKE_CURRENT_SOURCE_DIR}/Source)
target_link_libraries(HazenSnapshot PRIVATE
    juce::juce_audio_utils juce::juce_audio_formats juce::juce_audio_processors
    juce::juce_gui_basics
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
