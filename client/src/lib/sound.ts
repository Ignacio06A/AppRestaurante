let ctx: AudioContext | null = null;

/** Sonido breve generado (sin archivos) para alertas de nuevas comandas y pedidos listos. */
export function chime(kind: 'ticket' | 'ready' | 'alert') {
  try {
    if (localStorage.getItem('rms:mute') === '1') return;
  } catch {
    /* almacenamiento no disponible */
  }
  try {
    ctx ??= new AudioContext();
    const notes = kind === 'ticket' ? [880, 1175] : kind === 'ready' ? [659, 988, 1319] : [440, 330];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = ctx!.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(ctx!.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
  } catch {
    /* audio no disponible */
  }
}
