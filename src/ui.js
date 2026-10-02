import { ROOMS } from './config.js';

const $ = (id) => document.getElementById(id);

/** Thin DOM binding layer. Knows nothing about three.js. */
export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.panel = $('panel');
    this.clock = $('clock');
    this.phase = $('phase');
    this.slider = $('timeSlider');
    this.roomList = $('roomList');
    this.viewSeg = $('viewSeg');
    this.presetSeg = $('presetSeg');
    this.roof = $('optRoof');
    this.furniture = $('optFurniture');
    this.lamps = $('optLamps');
    this.sims = $('optSims');
    this.yard = $('optYard');
    this.auto = $('optAuto');
    this.spin = $('optSpin');
    this.btnReset = $('btnReset');
    this.btnToggle = $('panelToggle');

    // Debug (lightmap) controls
    this.dbgOverlay = $('dbgOverlay');
    this.dbgOverlayGain = $('dbgOverlayGain');
    this.dbgOverlayGainLabel = $('dbgOverlayGainLabel');
    this.dbgAdvanced = $('dbgAdvanced');
    this.dbgProbes = $('dbgProbes');
    this.dbgXray = $('dbgXray');
    this.dbgBuried = $('dbgBuried');
    this.dbgDir = $('dbgDir');
    this.dbgBands = $('dbgBands');
    this.dbgSlice = $('dbgSlice');
    this.dbgSliceLabel = $('dbgSliceLabel');
    this.dbgSize = $('dbgSize');
    this.dbgGain = $('dbgGain');
    this.dbgGainLabel = $('dbgGainLabel');
    this.dbgStats = $('dbgStats');
    this.dbgBandsOut = $('dbgBands-out');
    this.debugSection = $('debugSection');

    // 3 · the atlas texture
    this.dbgAtlasBox = $('dbgAtlasBox');
    this.atlasChannel = $('atlasChannel');
    this.atlasCharts = $('atlasCharts');
    this.atlasGrid = $('atlasGrid');
    this.atlasGain = $('atlasGain');
    this.atlasGainLabel = $('atlasGainLabel');

    this._buildRooms();
    this._bind();
  }

  _buildRooms() {
    for (const room of ROOMS) {
      const btn = document.createElement('button');
      btn.className = 'room-chip';
      btn.dataset.room = room.id;

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = `#${room.accent.toString(16).padStart(6, '0')}`;

      const label = document.createElement('span');
      label.textContent = room.name;

      const area = document.createElement('span');
      area.className = 'area';
      area.textContent = `${(room.x1 - room.x0) * (room.z1 - room.z0)} m²`;

      btn.append(dot, label, area);
      btn.addEventListener('click', () => this.h.onFocusRoom(room.id));
      this.roomList.appendChild(btn);
    }
  }

  _bind() {
    this.viewSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (!btn) return;
      this.setView(btn.dataset.view);
      this.h.onView(btn.dataset.view);
    });

    this.presetSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-hour]');
      if (!btn) return;
      const hour = parseFloat(btn.dataset.hour);
      this.setHour(hour);
      this.setAuto(false);
      this.h.onAuto(false);
      this.h.onHour(hour);
    });

    this.slider.addEventListener('input', () => {
      const hour = parseFloat(this.slider.value);
      this.h.onHour(hour);
    });

    const toggle = (el, key) =>
      el.addEventListener('change', () => this.h[key](el.checked));

    toggle(this.roof, 'onRoof');
    toggle(this.furniture, 'onFurniture');
    toggle(this.lamps, 'onLamps');
    toggle(this.sims, 'onSims');
    toggle(this.yard, 'onYard');
    toggle(this.spin, 'onSpin');

    this.auto.addEventListener('change', () => {
      this.h.onAuto(this.auto.checked);
      // Keep the slider live while the clock advances.
      this.slider.classList.toggle('cycling', this.auto.checked);
    });

    this.btnReset.addEventListener('click', () => this.h.onReset());
    this.btnToggle.addEventListener('click', () => this.togglePanel());

    // ── Debug: the surface lightmap is the headline view ───────
    this.dbgOverlay.addEventListener('change', () =>
      this.h.onDebugOverlay(this.dbgOverlay.checked)
    );
    this.dbgOverlayGain.addEventListener('input', () => {
      const gain = +this.dbgOverlayGain.value / 100;
      this.dbgOverlayGainLabel.textContent = gain.toFixed(2);
      if (this.dbgOverlay.checked) this.h.onDebugOverlay(true, gain);
    });

    // ── Debug: raw probe grid, tucked away ─────────────────────
    this.dbgProbes.addEventListener('change', () => {
      // Sub-controls are meaningless with the grid hidden.
      const on = this.dbgProbes.checked;
      this.dbgXray.disabled = !on;
      this.dbgBuried.disabled = !on;
      this.dbgSlice.disabled = !on;
      this.dbgSize.disabled = !on;
      this.dbgGain.disabled = !on;
      this.dbgDir.disabled = !on;
      this.dbgBands.disabled = !on;
      this.h.onDebugProbes(on);
    });
    this.dbgXray.addEventListener('change', () => this.h.onDebugXray(this.dbgXray.checked));
    this.dbgBuried.addEventListener('change', () => this.h.onDebugBuried(this.dbgBuried.checked));
    this.dbgOverlay.addEventListener('change', () => this.h.onDebugOverlay(this.dbgOverlay.checked));
    this.dbgDir.addEventListener('change', () => this.h.onDebugDirection(this.dbgDir.value));
    this.dbgBands.addEventListener('change', () => this.h.onDebugBands(this.dbgBands.value));
    this.dbgSize.addEventListener('input', () => this.h.onDebugSize(+this.dbgSize.value / 100));
    this.dbgGain.addEventListener('input', () => {
      const gain = +this.dbgGain.value / 100;
      this.dbgGainLabel.textContent = gain.toFixed(2);
      this.h.onDebugGain(gain);
    });
    this.dbgSlice.addEventListener('input', () => {
      const v = +this.dbgSlice.value;
      const all = v === +this.dbgSlice.max;
      this.dbgSliceLabel.textContent = all ? 'all' : String(v);
      this.h.onDebugSlice(all ? -1 : v);
    });

    // ── Debug 3: the atlas texture ─────────────────────────────
    this.dbgAtlasBox.addEventListener('toggle', () =>
      this.h.onDebugAtlasVisible(this.dbgAtlasBox.open)
    );

    const pushAtlas = () =>
      this.h.onDebugAtlas({
        channel: this.atlasChannel.value,
        charts: this.atlasCharts.checked,
        grid: this.atlasGrid.checked,
        gain: +this.atlasGain.value / 100,
      });

    for (const el of [this.atlasChannel, this.atlasCharts, this.atlasGrid]) {
      el.addEventListener('change', pushAtlas);
    }
    this.atlasGain.addEventListener('input', () => {
      const gain = +this.atlasGain.value / 100;
      this.atlasGainLabel.textContent = gain.toFixed(2);
      pushAtlas();
    });

    this.setDebugEnabled(false);
  }

  /** Grey out the whole debug section until a probe volume is available. */
  setDebugEnabled(on) {
    for (const el of [
      this.dbgOverlay, this.dbgOverlayGain,
      this.dbgProbes, this.dbgXray, this.dbgBuried,
      this.dbgDir, this.dbgBands, this.dbgSlice, this.dbgSize, this.dbgGain,
      this.atlasChannel, this.atlasCharts, this.atlasGrid, this.atlasGain,
    ]) {
      el.disabled = !on;
    }
    if (!on) {
      this.dbgStats.textContent = 'lightmap not loaded — run npm run bake';
      this.dbgBandsOut.textContent = '—';
    }
  }

  /**
   * Match the slice slider to the baked grid, so the control can never point
   * at a layer that does not exist. Layer count, then one extra stop (= all).
   */
  setDebugSlices(ny) {
    this.dbgSlice.max = String(ny);
    this.dbgSlice.value = String(ny);
    this.dbgSliceLabel.textContent = 'all';
    return ny;
  }

  /* ── State mirrors ──────────────────────────────────────────── */

  setView(mode) {
    for (const b of this.viewSeg.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.view === mode);
    }
    this.roof.checked = mode === 'full';
    this.roof.disabled = mode === 'plan';
  }

  setHour(hour) {
    this.slider.value = String(hour);
  }

  setAuto(on) {
    this.auto.checked = on;
  }

  setSpin(on) {
    this.spin.checked = on;
  }

  setRoof(on) {
    this.roof.checked = on;
  }

  setClock(hour, phase) {
    const h24 = ((hour % 24) + 24) % 24;
    const hh = Math.floor(h24);
    const mm = Math.floor((h24 - hh) * 60);
    this.clock.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    this.phase.textContent = phase;
  }

  setDebugStats(text) {
    this.dbgStats.textContent = text;
  }

  setDebugBands(text) {
    this.dbgBandsOut.textContent = text;
  }

  /** Programmatic toggle, used by the keyboard shortcut. */
  toggleLightmap() {
    this.dbgOverlay.checked = !this.dbgOverlay.checked;
    this.dbgOverlay.dispatchEvent(new Event('change'));
  }

  togglePanel() {
    this.panel.classList.toggle('collapsed');
  }

  hideLoader() {
    const el = $('loader');
    if (el) el.classList.add('done');
  }
}
