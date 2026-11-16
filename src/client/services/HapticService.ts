export type HapticType = 'tap' | 'boundary' | 'extra' | 'undo' | 'warning';

class HapticService {
  private static instance: HapticService;
  private enabled: boolean = true;

  private constructor() {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('cricket_sim_haptics');
      if (stored !== null) {
        this.enabled = stored === 'true';
      }
    }
  }

  static getInstance(): HapticService {
    if (!HapticService.instance) {
      HapticService.instance = new HapticService();
    }
    return HapticService.instance;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(val: boolean) {
    this.enabled = val;
    if (typeof window !== 'undefined') {
      localStorage.setItem('cricket_sim_haptics', val ? 'true' : 'false');
    }
  }

  trigger(type: HapticType = 'tap') {
    if (!this.enabled || typeof window === 'undefined') return;
    if (!('vibrate' in navigator)) return;

    try {
      switch (type) {
        case 'tap':
          // Crisp short tactile click
          navigator.vibrate(18);
          break;
        case 'boundary':
          // Double celebratory punch for 4s and 6s
          navigator.vibrate([40, 50, 60]);
          break;
        case 'extra':
          // Subtle double vibration
          navigator.vibrate([25, 35, 25]);
          break;
        case 'undo':
          // Reversal pulse
          navigator.vibrate([45, 30]);
          break;
        case 'warning':
          // Longer alert pulse
          navigator.vibrate([80, 50, 80]);
          break;
      }
    } catch {
      // Ignore vibration errors if blocked by browser policy
    }
  }
}

export const hapticService = HapticService.getInstance();
