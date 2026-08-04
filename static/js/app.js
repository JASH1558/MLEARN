/**
 * app.js — Living neural network background
 * ---------------------------------------------------------------
 * Fullscreen decorative "digital brain": neurons drift slowly,
 * signals travel along cached connections, and the whole thing
 * self-tunes its visual quality to hold frame rate. Warm orange
 * palette only. Attach to <canvas id="net-canvas">.
 *
 * Architecture (all classes below):
 *   SpatialGrid        - uniform hash grid, O(n) neighbor lookup
 *   Neuron             - single node's state
 *   Pulse              - a single traveling signal
 *   PulsePool          - fixed-size pool, reused forever (no GC churn)
 *   ConnectionBuilder  - builds/caches each neuron's neighbor list
 *   ActivityScheduler  - low-frequency "spontaneous" firing
 *   PerformanceManager - rolling frame-time average -> quality tier
 *   BrainEngine        - owns state, ticks simulation, draws frame
 *   AnimationLoop       - requestAnimationFrame driver
 * ---------------------------------------------------------------
 */

(() => {
  'use strict';

  const TWO_PI = Math.PI * 2;

  //-----------------------------------------------------------
  // Tunables
  //-----------------------------------------------------------
  const CONFIG = {
    minNeurons: 400,
    maxNeurons: 2400,
    neuronsPerPixel: 1 / 9000,     // density scaler based on screen area

    connectDistance: 150,          // max px length of a cached edge
    maxDegree: 5,                  // neighbors kept per neuron

    rebuildIntervalMs: 8000,       // how often the adjacency cache refreshes

    driftSpeed: 6,                 // px/sec, gentle floating motion
    steerChangeMs: [2000, 5000],   // random re-heading interval

    baseCooldownMs: 260,           // refractory period after firing
    signalSpeed: 220,              // px/sec pulse travel speed
    signalDecay: 0.985,            // per-update energy multiplier
    branchMin: 1,
    branchMax: 3,
    branchProbability: 0.72,       // chance a signal continues on arrival

    ambientFireEveryMs: [90, 260], // scheduler injects a fresh signal

    poolSize: 200,                 // hard cap on pulse objects ever created

    mouseRadius: 120,
    mouseExciteAmount: 0.35,

    dprCap: 1.5,

    colors: {
      bg: '#050302',
      neuron: 'rgba(255,150,60,',
      signal: 'rgba(255,190,110,',
      glow: 'rgba(255,120,40,',
      connection: 'rgba(255,110,40,'
    }
  };

  //-----------------------------------------------------------
  // Small helpers
  //-----------------------------------------------------------
  function randRange(min, max) {
    return min + Math.random() * (max - min);
  }

  function lerpAngleTowards(current, target, t) {
    return current + (target - current) * t;
  }

  //-----------------------------------------------------------
  // SpatialGrid — uniform bucket grid, no per-frame allocation
  // once built. Buckets are reused arrays cleared in place.
  //-----------------------------------------------------------
  class SpatialGrid {
    constructor(width, height, cellSize) {
      this.cellSize = cellSize;
      this._allocate(width, height);
    }

    _allocate(width, height) {
      this.cols = Math.max(1, Math.ceil(width / this.cellSize));
      this.rows = Math.max(1, Math.ceil(height / this.cellSize));
      const total = this.cols * this.rows;
      this.buckets = new Array(total);
      for (let i = 0; i < total; i++) this.buckets[i] = [];
    }

    resize(width, height) {
      this._allocate(width, height);
    }

    clear() {
      const b = this.buckets;
      for (let i = 0; i < b.length; i++) b[i].length = 0;
    }

    _cellIndex(x, y) {
      let cx = (x / this.cellSize) | 0;
      let cy = (y / this.cellSize) | 0;
      if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
      if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
      return cy * this.cols + cx;
    }

    insert(index, x, y) {
      this.buckets[this._cellIndex(x, y)].push(index);
    }

    // Visits every stored index whose cell overlaps the square
    // region around (x, y) with half-width r. No allocations.
    forEachNear(x, y, r, visitor) {
      const cs = this.cellSize;
      const minCx = Math.max(0, ((x - r) / cs) | 0);
      const maxCx = Math.min(this.cols - 1, ((x + r) / cs) | 0);
      const minCy = Math.max(0, ((y - r) / cs) | 0);
      const maxCy = Math.min(this.rows - 1, ((y + r) / cs) | 0);
      for (let cy = minCy; cy <= maxCy; cy++) {
        const rowBase = cy * this.cols;
        for (let cx = minCx; cx <= maxCx; cx++) {
          const bucket = this.buckets[rowBase + cx];
          for (let i = 0; i < bucket.length; i++) visitor(bucket[i]);
        }
      }
    }
  }

  //-----------------------------------------------------------
  // Neuron — plain, monomorphic object shape for fast field access.
  // Created once at startup; never allocated in the animation loop.
  //-----------------------------------------------------------
  class Neuron {
    constructor(x, y) {
      this.x = x;
      this.y = y;
      this.vx = 0;
      this.vy = 0;
      this.heading = Math.random() * TWO_PI;
      this.steerTimer = randRange(CONFIG.steerChangeMs[0], CONFIG.steerChangeMs[1]);
      this.radius = 1.4 + Math.random() * 1.6;
      this.energy = 0;        // current excitation, 0..1
      this.glow = 0;          // smoothed visual glow, 0..1
      this.cooldown = 0;      // ms remaining before it may fire again
      this.neighbors = null;  // Int32Array, filled by ConnectionBuilder
      this.activity = 0;      // lifetime fire counter (diagnostic/visual weight)
    }
  }

  //-----------------------------------------------------------
  // Pulse — a single traveling signal. Reused via PulsePool.
  //-----------------------------------------------------------
  class Pulse {
    constructor() {
      this.active = false;
      this.from = -1;
      this.to = -1;
      this.progress = 0;
      this.speed = CONFIG.signalSpeed;
      this.energy = 1;
      this.x = 0;
      this.y = 0;
    }
  }

  //-----------------------------------------------------------
  // PulsePool — fixed pool of Pulse objects. acquire()/releaseAt()
  // never allocate; activeList tracks currently-live pulses.
  //-----------------------------------------------------------
  class PulsePool {
    constructor(size) {
      this.pulses = new Array(size);
      for (let i = 0; i < size; i++) this.pulses[i] = new Pulse();
      this.free = [];
      for (let i = size - 1; i >= 0; i--) this.free.push(i);
      this.activeList = [];
    }

    acquire() {
      if (this.free.length === 0) return -1; // pool exhausted, drop signal
      const idx = this.free.pop();
      this.pulses[idx].active = true;
      this.activeList.push(idx);
      return idx;
    }

    // Releases the pulse stored at activeList[pos] via swap-with-last.
    releaseAt(pos) {
      const idx = this.activeList[pos];
      this.pulses[idx].active = false;
      const last = this.activeList.length - 1;
      this.activeList[pos] = this.activeList[last];
      this.activeList.pop();
      this.free.push(idx);
    }
  }

  //-----------------------------------------------------------
  // ConnectionBuilder — builds each neuron's cached neighbor list
  // from the (already fresh) spatial grid. Only invoked periodically.
  //-----------------------------------------------------------
  class ConnectionBuilder {
    constructor(neurons, grid) {
      this.neurons = neurons;
      this.grid = grid;
      this._candIdx = new Int32Array(64);
      this._candD2 = new Float64Array(64);
    }

    rebuild() {
      const { neurons, grid } = this;
      const maxD = CONFIG.connectDistance;
      const maxD2 = maxD * maxD;
      const maxDeg = CONFIG.maxDegree;
      const cIdx = this._candIdx;
      const cD2 = this._candD2;
      const cap = cIdx.length;

      for (let i = 0; i < neurons.length; i++) {
        const n = neurons[i];
        let count = 0;

        grid.forEachNear(n.x, n.y, maxD, (j) => {
          if (j === i || count >= cap) return;
          const dx = neurons[j].x - n.x;
          const dy = neurons[j].y - n.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= maxD2) {
            cIdx[count] = j;
            cD2[count] = d2;
            count++;
          }
        });

        // Partial selection sort: keep the `maxDeg` closest candidates.
        const keep = Math.min(maxDeg, count);
        for (let a = 0; a < keep; a++) {
          let best = a;
          for (let b = a + 1; b < count; b++) {
            if (cD2[b] < cD2[best]) best = b;
          }
          if (best !== a) {
            const td = cD2[a]; cD2[a] = cD2[best]; cD2[best] = td;
            const ti = cIdx[a]; cIdx[a] = cIdx[best]; cIdx[best] = ti;
          }
        }

        const neighbors = new Int32Array(keep);
        for (let a = 0; a < keep; a++) neighbors[a] = cIdx[a];
        n.neighbors = neighbors;
      }
    }
  }

  //-----------------------------------------------------------
  // ActivityScheduler — keeps the network alive with rare,
  // spontaneous firings so it never goes fully dark.
  //-----------------------------------------------------------
  class ActivityScheduler {
    constructor(engine) {
      this.engine = engine;
      this.nextFireIn = randRange(CONFIG.ambientFireEveryMs[0], CONFIG.ambientFireEveryMs[1]);
    }

    update(dtMs) {
      this.nextFireIn -= dtMs;
      if (this.nextFireIn <= 0) {
        this.nextFireIn = randRange(CONFIG.ambientFireEveryMs[0], CONFIG.ambientFireEveryMs[1]);
        this.engine.igniteRandomNeuron();
      }
    }
  }

  //-----------------------------------------------------------
  // PerformanceManager — rolling frame-time average drives an
  // adaptive quality tier (glow, connection alpha, pulse cap).
  //-----------------------------------------------------------
  class PerformanceManager {
    constructor() {
      this.samples = new Float32Array(30);
      this.sampleIdx = 0;
      this.filled = 0;
      this.tier = 2; // 0 = low, 1 = medium, 2 = high
      this.tierChangeCooldown = 0;
    }

    update(dtMs) {
      this.samples[this.sampleIdx] = dtMs;
      this.sampleIdx = (this.sampleIdx + 1) % this.samples.length;
      if (this.filled < this.samples.length) this.filled++;

      if (this.tierChangeCooldown > 0) {
        this.tierChangeCooldown -= dtMs;
        return;
      }
      if (this.filled < this.samples.length) return;

      let sum = 0;
      for (let i = 0; i < this.filled; i++) sum += this.samples[i];
      const avg = sum / this.filled;

      if (avg > 22 && this.tier > 0) {          // sustained < ~45fps
        this.tier--;
        this.tierChangeCooldown = 3000;
      } else if (avg < 14 && this.tier < 2) {   // sustained > ~70fps
        this.tier++;
        this.tierChangeCooldown = 3000;
      }
    }

    settings() {
      switch (this.tier) {
        case 0: return { glow: false, shadowBlur: 0, connectionAlpha: 0.35, maxPulses: 60 };
        case 1: return { glow: true, shadowBlur: 6, connectionAlpha: 0.6, maxPulses: 100 };
        default: return { glow: true, shadowBlur: 12, connectionAlpha: 1, maxPulses: 150 };
      }
    }
  }

  //-----------------------------------------------------------
  // BrainEngine — owns all state, advances the simulation, draws.
  //-----------------------------------------------------------
  class BrainEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.dpr = Math.min(CONFIG.dprCap, window.devicePixelRatio || 1);

      this.width = 0;
      this.height = 0;
      this.grid = null;
      this._resize();

      const count = this._computeNeuronCount();
      this.neurons = new Array(count);
      for (let i = 0; i < count; i++) {
        this.neurons[i] = new Neuron(Math.random() * this.width, Math.random() * this.height);
      }

      const cellSize = Math.max(60, CONFIG.connectDistance * 0.6);
      this.grid = new SpatialGrid(this.width, this.height, cellSize);
      this.connectionBuilder = new ConnectionBuilder(this.neurons, this.grid);
      this.pulsePool = new PulsePool(CONFIG.poolSize);
      this.perf = new PerformanceManager();
      this.activityScheduler = new ActivityScheduler(this);

      this.rebuildTimer = 0; // forces an immediate build on frame 1
      this._scratchBranch = new Int32Array(CONFIG.branchMax);

      this.mouseX = 0;
      this.mouseY = 0;
      this.mouseActive = false;
      this._mouseVisitor = (idx) => this._exciteIfNear(idx);

      this._bindEvents();
    }

    _computeNeuronCount() {
      const area = this.width * this.height;
      let count = Math.round(area * CONFIG.neuronsPerPixel);
      if (count < CONFIG.minNeurons) count = CONFIG.minNeurons;
      if (count > CONFIG.maxNeurons) count = CONFIG.maxNeurons;
      return count;
    }

    _resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.width = w;
      this.height = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.grid) this.grid.resize(w, h);
    }

    _bindEvents() {
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => this._resize(), 150);
      });
      window.addEventListener('mousemove', (e) => {
        this.mouseX = e.clientX;
        this.mouseY = e.clientY;
        this.mouseActive = true;
      }, { passive: true });
      window.addEventListener('mouseleave', () => {
        this.mouseActive = false;
      });
    }

    //--- signal propagation -----------------------------------

    firePulse(fromIdx, toIdx, energy) {
      const idx = this.pulsePool.acquire();
      if (idx === -1) return;
      const p = this.pulsePool.pulses[idx];
      const from = this.neurons[fromIdx];
      p.from = fromIdx;
      p.to = toIdx;
      p.progress = 0;
      p.energy = energy;
      p.speed = CONFIG.signalSpeed * (0.85 + Math.random() * 0.3);
      p.x = from.x;
      p.y = from.y;
    }

    igniteRandomNeuron() {
      const neurons = this.neurons;
      const idx = (Math.random() * neurons.length) | 0;
      const neuron = neurons[idx];
      if (!neuron.neighbors || neuron.neighbors.length === 0) return;
      if (this.pulsePool.activeList.length >= this.perf.settings().maxPulses) return;
      neuron.energy = Math.min(1, neuron.energy + 0.6);
      const target = neuron.neighbors[(Math.random() * neuron.neighbors.length) | 0];
      this.firePulse(idx, target, 0.9);
    }

    onPulseArrive(p) {
      const dest = this.neurons[p.to];
      dest.energy = Math.min(1, dest.energy + p.energy * 0.85);
      dest.activity++;

      if (dest.cooldown > 0) return;               // refractory: no branching
      if (!dest.neighbors || dest.neighbors.length === 0) return;
      if (Math.random() > CONFIG.branchProbability) {
        dest.cooldown = CONFIG.baseCooldownMs * (0.6 + Math.random() * 0.5);
        return;
      }
      if (this.pulsePool.activeList.length >= this.perf.settings().maxPulses) return;

      const maxBranch = Math.min(CONFIG.branchMax, dest.neighbors.length);
      const branchCount = Math.max(
        CONFIG.branchMin,
        (Math.random() * (maxBranch - CONFIG.branchMin + 1) | 0) + CONFIG.branchMin
      );

      const chosen = this._scratchBranch;
      let picked = 0;
      let guard = 0;
      while (picked < branchCount && guard < 10) {
        guard++;
        const cand = dest.neighbors[(Math.random() * dest.neighbors.length) | 0];
        if (cand === p.from && dest.neighbors.length > 1 && Math.random() < 0.7) continue;
        let dup = false;
        for (let k = 0; k < picked; k++) {
          if (chosen[k] === cand) { dup = true; break; }
        }
        if (dup) continue;
        chosen[picked++] = cand;
      }
      for (let k = 0; k < picked; k++) {
        this.firePulse(p.to, chosen[k], p.energy * 0.9);
      }
      dest.cooldown = CONFIG.baseCooldownMs * (0.75 + Math.random() * 0.5);
    }

    updatePulses(dtSec) {
      const pool = this.pulsePool;
      const list = pool.activeList;
      let i = list.length - 1;
      while (i >= 0) {
        const idx = list[i];
        const p = pool.pulses[idx];
        const from = this.neurons[p.from];
        const to = this.neurons[p.to];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        p.progress += (p.speed * dtSec) / dist;
        p.energy *= CONFIG.signalDecay;

        if (p.progress >= 1 || p.energy < 0.05) {
          this.onPulseArrive(p);
          pool.releaseAt(i);
        } else {
          p.x = from.x + dx * p.progress;
          p.y = from.y + dy * p.progress;
        }
        i--;
      }
    }

    //--- neuron motion & decay ---------------------------------

    updateNeurons(dtMs) {
      const dtSec = dtMs / 1000;
      const w = this.width;
      const h = this.height;
      const margin = 40;
      const neurons = this.neurons;

      for (let i = 0; i < neurons.length; i++) {
        const n = neurons[i];

        if (n.cooldown > 0) n.cooldown -= dtMs;
        n.energy *= CONFIG.signalDecay;
        if (n.energy < 0.001) n.energy = 0;
        n.glow += (n.energy - n.glow) * Math.min(1, dtSec * 6);

        n.steerTimer -= dtMs;
        if (n.steerTimer <= 0) {
          n.steerTimer = randRange(CONFIG.steerChangeMs[0], CONFIG.steerChangeMs[1]);
          n.heading += (Math.random() - 0.5) * 1.2;
        }

        if (n.x < margin) n.heading = lerpAngleTowards(n.heading, 0, 0.05);
        else if (n.x > w - margin) n.heading = lerpAngleTowards(n.heading, Math.PI, 0.05);
        if (n.y < margin) n.heading = lerpAngleTowards(n.heading, Math.PI / 2, 0.05);
        else if (n.y > h - margin) n.heading = lerpAngleTowards(n.heading, -Math.PI / 2, 0.05);

        n.vx = Math.cos(n.heading) * CONFIG.driftSpeed;
        n.vy = Math.sin(n.heading) * CONFIG.driftSpeed;
        n.x += n.vx * dtSec;
        n.y += n.vy * dtSec;

        if (n.x < 0) n.x = 0; else if (n.x > w) n.x = w;
        if (n.y < 0) n.y = 0; else if (n.y > h) n.y = h;
      }
    }

    _exciteIfNear(idx) {
      const n = this.neurons[idx];
      const dx = n.x - this.mouseX;
      const dy = n.y - this.mouseY;
      const r = CONFIG.mouseRadius;
      const d2 = dx * dx + dy * dy;
      if (d2 < r * r) {
        const falloff = 1 - Math.sqrt(d2) / r;
        n.energy = Math.min(1, n.energy + CONFIG.mouseExciteAmount * falloff * 0.05);
      }
    }

    handleMouse() {
      if (!this.mouseActive) return;
      this.grid.forEachNear(this.mouseX, this.mouseY, CONFIG.mouseRadius, this._mouseVisitor);
    }

    //--- main tick ----------------------------------------------

    update(dtMs) {
      // Spatial grid is refreshed every frame (cheap, O(n), no sqrt);
      // the adjacency cache built from it is only rebuilt periodically.
      this.grid.clear();
      const neurons = this.neurons;
      for (let i = 0; i < neurons.length; i++) {
        this.grid.insert(i, neurons[i].x, neurons[i].y);
      }

      this.rebuildTimer -= dtMs;
      if (this.rebuildTimer <= 0) {
        this.rebuildTimer = CONFIG.rebuildIntervalMs;
        this.connectionBuilder.rebuild();
      }

      this.updateNeurons(dtMs);
      this.updatePulses(dtMs / 1000);
      this.activityScheduler.update(dtMs);
      this.handleMouse();
      this.perf.update(dtMs);
    }

    //--- rendering ------------------------------------------------

    draw(ctx) {
      const { width, height } = this;
      const settings = this.perf.settings();
      const neurons = this.neurons;

      ctx.fillStyle = CONFIG.colors.bg;
      ctx.fillRect(0, 0, width, height);

      // Connections
      ctx.lineWidth = 1;
      for (let i = 0; i < neurons.length; i++) {
        const n = neurons[i];
        const nb = n.neighbors;
        if (!nb) continue;
        for (let k = 0; k < nb.length; k++) {
          const j = nb[k];
          if (j <= i) continue; // draw each edge once
          const m = neurons[j];
          const dx = m.x - n.x;
          const dy = m.y - n.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const t = 1 - Math.min(1, dist / CONFIG.connectDistance);
          const alpha = t * 0.5 * settings.connectionAlpha;
          if (alpha <= 0.01) continue;
          ctx.strokeStyle = CONFIG.colors.connection + alpha.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(n.x, n.y);
          ctx.lineTo(m.x, m.y);
          ctx.stroke();
        }
      }

      // Signals (pulses)
      const pool = this.pulsePool;
      const activeList = pool.activeList;
      if (settings.shadowBlur > 0) {
        ctx.shadowBlur = settings.shadowBlur;
        ctx.shadowColor = 'rgba(255,150,60,0.9)';
      }
      for (let i = 0; i < activeList.length; i++) {
        const p = pool.pulses[activeList[i]];
        const alpha = Math.max(0, Math.min(1, p.energy));
        ctx.fillStyle = CONFIG.colors.signal + alpha.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, TWO_PI);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // Neurons + glow
      for (let i = 0; i < neurons.length; i++) {
        const n = neurons[i];
        const glow = n.glow;
        if (settings.glow && glow > 0.03) {
          ctx.shadowBlur = settings.shadowBlur * (0.5 + glow);
          ctx.shadowColor = CONFIG.colors.glow + Math.min(1, glow).toFixed(3) + ')';
        } else {
          ctx.shadowBlur = 0;
        }
        const alpha = 0.35 + glow * 0.65;
        ctx.fillStyle = CONFIG.colors.neuron + alpha.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius * (1 + glow * 0.6), 0, TWO_PI);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
  }

  //-----------------------------------------------------------
  // AnimationLoop — requestAnimationFrame driver with dt clamp.
  //-----------------------------------------------------------
  class AnimationLoop {
    constructor(engine) {
      this.engine = engine;
      this.lastTime = 0;
      this._tick = this._tick.bind(this);
    }

    start() {
      this.lastTime = performance.now();
      requestAnimationFrame(this._tick);
    }

    _tick(now) {
      let dtMs = now - this.lastTime;
      this.lastTime = now;
      if (dtMs > 100) dtMs = 100; // clamp hitches from tab switches, etc.

      this.engine.update(dtMs);
      this.engine.draw(this.engine.ctx);

      requestAnimationFrame(this._tick);
    }
  }

  //-----------------------------------------------------------
  // Bootstrap
  //-----------------------------------------------------------
  function init() {
    const canvas = document.getElementById('net-canvas');
    if (!canvas) return;
    const engine = new BrainEngine(canvas);
    const loop = new AnimationLoop(engine);
    loop.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
