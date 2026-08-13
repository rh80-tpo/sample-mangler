// Does editor activity disturb the audio?
//
// It used to, badly. processBlock took a try-lock on the same mutex the editor's
// 20Hz timer took for peaks, waveform and status — and peaks and rms each
// scanned the whole rendered buffer while holding it, millions of samples for a
// 32 bar chop. Every time the lock was busy, processBlock bailed and emitted a
// block of silence. That is audible as constant clicking, and raising the buffer
// size makes it worse rather than better, because a dropped block is a longer
// hole.
//
// The audio thread no longer locks at all. This runs the same playback twice,
// once quiet and once with the editor's accessors hammered from another thread,
// and compares them sample for sample. Any difference is caused by contention.
#include <juce_audio_processors/juce_audio_processors.h>
#include <cstdio>
#include <atomic>
#include <thread>
#include "../plugin/Source/PluginProcessor.h"

static void writeWav(const juce::File& f) {
  const double sr = 44100.0; const int n = int(sr * 4);
  juce::AudioBuffer<float> b(1, n); auto* d = b.getWritePointer(0); double ph = 0;
  for (int k = 0; k < 10; ++k) { const int at = int((k*0.38+0.05)*sr), len = int(0.30*sr);
    for (int i = 0; i < len && at+i < n; ++i) { const double t = i/sr,
      e = juce::jmin(1.0, i/200.0)*std::exp(-t*4); ph += 2*M_PI*(220.0+k*13)/sr;
      d[at+i] += float(std::sin(ph)*0.7*e); } }
  f.deleteFile(); juce::WavAudioFormat w;
  std::unique_ptr<juce::FileOutputStream> os(f.createOutputStream());
  std::unique_ptr<juce::AudioFormatWriter> wr(w.createWriterFor(os.get(), sr,1,16,{},0));
  if (wr) { os.release(); wr->writeFromAudioSampleBuffer(b,0,n); }
}

int main() {
  juce::ScopedJuceInitialiser_GUI init;
  const auto wav = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("click.wav");
  writeWav(wav);
  HazenSamplerProcessor p;
  p.setPlayConfigDetails(0,2,44100.0,512);
  p.prepareToPlay(44100.0,512);
  p.loadSample(wav);
  for (int i=0;i<200 && (p.isRendering()||p.renderedSeconds()<=0.0);++i) juce::Thread::sleep(25);

  const int blocks = 800, size = 512;

  // Capture the same playback twice: once quiet, once with the editor's
  // accessors hammered from another thread the way the 20Hz timer does.
  //
  // Comparing the two is the only honest way to measure this. Counting "silent
  // blocks" was not: the test signal is sparse tone bursts with real gaps in it,
  // so a fifth of its blocks are quiet by nature and the first version of this
  // reported that as a 20% dropout rate. Any difference between the two runs is
  // caused by contention and nothing else.
  auto capture = [&](bool withUi) {
    std::atomic<bool> stop{false};
    std::thread ui;
    if (withUi) ui = std::thread([&]{ while(!stop.load()){
        (void)p.peaks(600); (void)p.rms(600); (void)p.voiceStarts();
        (void)p.voiceSlices(); (void)p.status(); (void)p.renderedSeconds();
        (void)p.playPosition(); (void)p.sampleName(); (void)p.hasSample();
        std::this_thread::sleep_for(std::chrono::microseconds(300)); } });
    p.stopPlayback();
    juce::AudioBuffer<float> flush(2,size); juce::MidiBuffer none;
    for (int i=0;i<40;++i){ flush.clear(); p.processBlock(flush,none); }
    p.startPlayback();
    std::vector<float> out; out.reserve(size_t(blocks)*size_t(size));
    juce::AudioBuffer<float> buf(2,size);
    for (int b=0;b<blocks;++b){ buf.clear(); p.processBlock(buf,none);
      for(int i=0;i<size;++i) out.push_back(buf.getSample(0,i));
      if (withUi) std::this_thread::sleep_for(std::chrono::microseconds(120)); }
    if (withUi){ stop.store(true); ui.join(); }
    return out;
  };

  const auto quiet = capture(false);
  const auto loaded = capture(true);

  std::size_t differing = 0; float worstDiff = 0.0f;
  for (std::size_t i = 0; i < std::min(quiet.size(), loaded.size()); ++i) {
    const float d = std::abs(quiet[i] - loaded[i]);
    if (d > 1.0e-6f) { ++differing; worstDiff = juce::jmax(worstDiff, d); }
  }

  // A dropout shows up as a step far larger than anything the material contains.
  std::vector<float> steps;
  steps.reserve(loaded.size());
  for (std::size_t i = 1; i < loaded.size(); ++i) steps.push_back(std::abs(loaded[i]-loaded[i-1]));
  auto sorted = steps; std::sort(sorted.begin(), sorted.end());
  const float p999 = sorted.empty() ? 0.0f : sorted[std::size_t(0.999*double(sorted.size()))];
  const float maxStep = sorted.empty() ? 0.0f : sorted.back();

  printf("  contention: captured           %d blocks of %d, twice\n", blocks, size);
  printf("  samples differing  %zu of %zu  (%.4f%%)  worst %.6f\n",
         differing, quiet.size(), 100.0*double(differing)/double(quiet.size()), worstDiff);
  printf("  step p99.9         %.5f   max step %.5f   ratio %.2fx\n",
         p999, maxStep, p999 > 0 ? maxStep/p999 : 0.0);

  // Where is the worst step? A loop that clicks does it at the wrap, once per
  // period; material with a sharp transient does it wherever the transient is.
  std::size_t worstAt = 0;
  for (std::size_t i = 1; i < loaded.size(); ++i)
    if (std::abs(loaded[i]-loaded[i-1]) >= maxStep) { worstAt = i; break; }
  const double loopFrames = p.renderedSeconds() * 44100.0;
  printf("  worst step at      sample %zu  (%.3fs in, %.4f through the loop)\n",
         worstAt, double(worstAt)/44100.0, std::fmod(double(worstAt), loopFrames)/loopFrames);

  // How many big steps, and do they land at the same place in each loop?
  int big = 0; std::vector<double> phases;
  for (std::size_t i = 1; i < loaded.size(); ++i) {
    if (std::abs(loaded[i]-loaded[i-1]) > p999 * 4.0f) {
      ++big; phases.push_back(std::fmod(double(i), loopFrames)/loopFrames);
    }
  }
  printf("  steps > 4x p99.9   %d\n", big);
  for (std::size_t i = 0; i < std::min<std::size_t>(6, phases.size()); ++i)
    printf("      at %.4f through the loop\n", phases[i]);
  p.stopPlayback();
  return (differing == 0) ? 0 : 1;
}