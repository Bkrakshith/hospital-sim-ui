// iPad Safari platform services (05 §7): audio earcons, speech readback, Wake Lock.
// - No haptics: navigator.vibrate does not exist in iOS Safari. All feedback is visual (+ optional sound).
// - Audio is unlocked on a user gesture (sign-in tap / first wake tap); navigator.audioSession.type = 'playback'
//   (Safari 16.4+) so alarm tones are not muted by the silent switch.
// - The robot's own speaker is the primary audible channel; the iPad plays as a second channel.

let ctx = null;
export const sound = {
  unlocked: false,
  verified: false,            // set by the sound check ("Did you hear the tone?")
  muted: false,
  unlock() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* not supported */ }
    try {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      // a silent buffer unlocks iOS output
      if (ctx) { const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); }
      this.unlocked = !!ctx;
    } catch { this.unlocked = false; }
    try { if ('speechSynthesis' in window) speechSynthesis.getVoices(); } catch { /* ignore */ }
    return this.unlocked;
  },
  // notes: [freqHz, startS, durS]
  _play(notes, gain = 0.18) {
    if (!ctx || this.muted) return;
    const t0 = ctx.currentTime + 0.02;
    for (const [f, st, d] of notes) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      // a little harmonic content helps the tone carry through masks and noise without being shrill
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2; const g2 = ctx.createGain(); g2.gain.value = 0.25;
      g.gain.setValueAtTime(0, t0 + st);
      g.gain.linearRampToValueAtTime(gain, t0 + st + 0.015);
      g.gain.setValueAtTime(gain, t0 + st + d - 0.03);
      g.gain.linearRampToValueAtTime(0, t0 + st + d);
      o.connect(g); o2.connect(g2); g2.connect(g); g.connect(ctx.destination);
      o.start(t0 + st); o2.start(t0 + st); o.stop(t0 + st + d + 0.02); o2.stop(t0 + st + d + 0.02);
    }
  },
  // IEC 60601-1-8-like burst patterns (by analogy): High 10 pulses (3+2, pause, 3+2), Medium 3 pulses, Low 2 soft
  high() { const C = 523, A = 880, F = 698; const p = [C, A, F, A, F]; const n = []; p.forEach((f, i) => n.push([f, i * 0.13 + (i > 2 ? 0.12 : 0), 0.1])); p.forEach((f, i) => n.push([f, 1.0 + i * 0.13 + (i > 2 ? 0.12 : 0), 0.1])); this._play(n, 0.22); },
  medium() { this._play([[523, 0, 0.18], [659, 0.24, 0.18], [784, 0.48, 0.18]], 0.18); },
  low() { this._play([[659, 0, 0.22], [523, 0.3, 0.26]], 0.1); },
  arrived() { this._play([[523, 0, 0.16], [784, 0.18, 0.28]], 0.09); },
  done() { this._play([[659, 0, 0.3]], 0.08); },
  check() { this._play([[659, 0, 0.25], [784, 0.3, 0.25], [988, 0.6, 0.35]], 0.16); },
};

export const speech = {
  enabled: true,
  say(text) {
    if (!this.enabled || !('speechSynthesis' in window) || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/→/g, 'to'));
      u.rate = 0.95; u.pitch = 1.0; u.lang = 'en-GB';
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  },
};

// Screen Wake Lock while the robot moves or an alarm is active (D-3). Re-requested on visibilitychange.
export const wake = {
  want: false, lock: null, supported: 'wakeLock' in navigator,
  async set(want) {
    this.want = want;
    if (!this.supported) return;
    if (want && !this.lock && document.visibilityState === 'visible') {
      try { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => { this.lock = null; }); } catch { this.lock = null; }
    } else if (!want && this.lock) {
      try { await this.lock.release(); } catch { /* ignore */ }
      this.lock = null;
    }
  },
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wake.want) wake.set(true); });

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
