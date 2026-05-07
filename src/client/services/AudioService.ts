export class AudioService {
  private static instance: AudioService;
  private synth: SpeechSynthesis;
  public isEnabled: boolean = false;

  private constructor() {
    this.synth = window.speechSynthesis;
  }

  static getInstance() {
    if (!AudioService.instance) {
      AudioService.instance = new AudioService();
    }
    return AudioService.instance;
  }

  enable() {
    // Requires a user gesture
    if (this.synth.getVoices().length === 0) {
      console.warn('Voices not loaded yet');
    }
    // Speak a silent utterance to enable audio context on iOS/browsers
    const utterance = new SpeechSynthesisUtterance('');
    utterance.volume = 0;
    this.synth.speak(utterance);
    this.isEnabled = true;
  }

  speak(text: string) {
    if (!this.isEnabled) return;
    
    // Cancel any ongoing speech so new speech is immediate
    this.synth.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.1; // Slightly faster for punchiness
    utterance.pitch = 1.0;
    
    // Find an English voice, preferably clean sounding
    const voices = this.synth.getVoices();
    const voice = voices.find((v) => v.lang.startsWith('en-'));
    if (voice) utterance.voice = voice;
    
    this.synth.speak(utterance);
  }
}

export const audioService = AudioService.getInstance();
