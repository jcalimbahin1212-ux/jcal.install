/**
 * Project Deathbed - A pixel art adventure game
 * Features sprite animation, dialogue system, and interactive world exploration
 */

// ============================================================================
// CANVAS & RENDERING SETUP
// ============================================================================

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// ============================================================================
// CONSTANTS
// ============================================================================

const TILE = 20; // Increased from 16 for larger screen
const SCALE = 2; // Scaling factor for sprites

const COLORS = {
  bg: '#03060c',
  floor: '#0d1520',
  wall: '#1a2634',
  panel: '#192838',
  glow: '#39d1ff',
  lumenGlow: '#88ffdd',
  bed: '#263445',
  blanket: '#88b4c5',
  door: '#6c7aa1',
  dust: '#c8d4e8',
};

const SCENE_COLORS = {
  house: {
    floor: '#0d1520',
    wall: '#1a2634',
    door: '#6c7aa1',
  },
  rooftop: {
    floor: '#041528',
    wall: '#0b1f37',
    door: '#9bc7ff',
  },
  relay: {
    floor: '#090f1b',
    wall: '#161f2f',
    door: '#b29dff',
  },
};

const ANIM_SPEED = {
  idle: 0.6,
  walk: 0.2,
  sprint: 0.12,
  crouch: 0.4,
};

const SPRITES = createSprites();

// ============================================================================
// SPRITE SYSTEM
// ============================================================================

/**
 * Retrieves a character frame for animation
 * @param {string} name - Character sprite set name
 * @param {string} state - Animation state (idle, walk, sprint, crouch, etc.)
 * @param {number} frameIndex - Frame index in the animation
 * @returns {Object|null} Frame object with pixel data or null if not found
 */
function getCharacterFrame(name, state, frameIndex) {
  const set = SPRITES[name];
  if (!set) return null;
  const frames = set[state] || set.idle || [];
  if (!frames.length) return null;
  return frames[frameIndex % frames.length];
}

/**
 * Draws a pixel frame on the canvas
 * @param {Object} frame - Frame object with pixels array and dimensions
 * @param {number} x - Canvas x position
 * @param {number} y - Canvas y position
 */
function drawFrame(frame, x, y) {
  if (!frame) return;
  for (let i = 0; i < frame.pixels.length; i++) {
    const color = frame.pixels[i];
    if (!color) continue;
    const sx = i % frame.w;
    const sy = Math.floor(i / frame.w);
    ctx.fillStyle = color;
    ctx.fillRect(x + sx, y + sy, 1, 1);
  }
}

// ============================================================================
// WORLD MAPS
// ============================================================================

// ============================================================================
// WORLD MAPS
// ============================================================================

const maps = {
  planetarium: {
    width: 32,
    height: 18,
    rows: [
      '################################',
      '#..............................#',
      '#..............................#',
      '#...######..........######.....#',
      '#...#....#..........#....#.....#',
      '#...#....#..........#....#.....#',
      '#...######..........######.....#',
      '#..............................#',
      '#..............................#',
      '#..........########............#',
      '#..........#......#............#',
      '#..........#......#............#',
      '#..........#......#............#',
      '#..........########............#',
      '#..............................#',
      '#..............................D',
      '#..............................#',
      '################################',
    ],
  },
  house: {
    width: 20,
    height: 12,
    rows: [
      '####################',
      '#..................#',
      '#..######..######..#',
      '#..#D..D#..#D..D#..#',
      '#..#....#..#....#..#',
      '#..######..######..#',
      '#..................#',
      '#....######........#',
      '#....#....#........#',
      '#....#....#....D...#',
      '#....######........#',
      '####################',
    ],
  },
  rooftop: {
    width: 24,
    height: 14,
    rows: [
      '########################',
      '#......................#',
      '#......................#',
      '#....##########........#',
      '#....#........#........#',
      '#....#........#........#',
      '#....##########........#',
      '#......................#',
      '#......................#',
      '#..######..............#',
      '#..#....#..............#',
      '#..#....#..............#',
      '#..######..............#',
      '########################',
    ],
  },
  relay: {
    width: 24,
    height: 14,
    rows: [
      '########################',
      '#......................#',
      '#......................#',
      '#..........##..........#',
      '#..........##..........#',
      '#......................#',
      '#......########......###',
      '#......#......#......###',
      '#......#......#......###',
      '#......########......###',
      '#......................#',
      '#......................#',
      '#......................#',
      '########################',
    ],
  },
};

// ============================================================================
// GAME STATE
// ============================================================================

/**
 * Global game state object
 */
const state = {
  scene: 'prologue',
  time: 0,
  map: null,
  entities: [],
  flags: {},
  fade: 1,
  fadeTarget: 0,
  fadeCallback: null,
  followers: [], // Characters following the player
  playerPath: [], // History of player positions for followers to follow
};

// ============================================================================
// PLAYER OBJECT
// ============================================================================

/**
 * Player character object with position, animation, and input state
 * Plays as Luis Alejandro Moreno - twin brother of Adrian
 */
const player = {
  x: 9 * TILE,
  y: 8 * TILE,
  w: 14,
  h: 18,
  speed: 60,
  sprite: 'luis',
  visible: false,
  frozen: true,
  dirX: 0,
  dirY: 0,
  crouch: false,
  lookUpTimer: 0,
  sprinting: false,
  anim: {
    state: 'idle',
    frame: 0,
    timer: 0,
  },
};

// ============================================================================
// INPUT & UI STATE
// ============================================================================

const keys = new Set();
const dialogueBox = document.getElementById('dialogue');
const dialogueText = document.getElementById('dialogue-text');
const inventoryEl = document.getElementById('inventory');
const inventory = [];

/**
 * Dialogue system state
 */
const dialogue = {
  queue: [],
  active: false,
  onComplete: null,
  auto: false,
  autoDelay: 2.5,
  autoTimer: 0,
};

// ============================================================================
// AUDIO SYSTEM
// ============================================================================

const audio = { ctx: null, running: false, layers: [] };

/**
 * Ensures Web Audio API context is initialized
 */
function ensureAudio() {
  if (audio.ctx) return;
  audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
}

// ============================================================================
// MAP UTILITIES
// ============================================================================

function setMapTile(map, x, y, char) {
  if (!map || y < 0 || y >= map.rows.length) return;
  const rows = [...map.rows];
  const row = rows[y].split('');
  row[x] = char;
  rows[y] = row.join('');
  map.rows = rows;
}

// ============================================================================
// AUDIO GENERATION & SOUNDTRACK
// ============================================================================

/**
 * Starts the ambient soundtrack using Web Audio API
 */
function startSoundtrack() {
  ensureAudio();
  if (!audio.ctx || audio.running) return;
  audio.running = true;
  audio.layers = [];
  const ctxAudio = audio.ctx;
  const master = ctxAudio.createGain();
  master.gain.value = 0.5;
  master.connect(ctxAudio.destination);

  const padNotes = [174, 220, 261, 329];
  padNotes.forEach((freq, i) => {
    const osc = ctxAudio.createOscillator();
    const gain = ctxAudio.createGain();
    osc.type = i % 2 ? 'triangle' : 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(master);
    const now = ctxAudio.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 3);
    osc.start();
    audio.layers.push({ stop: () => fadeStop(osc, gain) });
  });

  const arpGain = ctxAudio.createGain();
  arpGain.gain.value = 0.08;
  arpGain.connect(master);
  const arpNotes = [329, 392, 523, 659];
  let arpIndex = 0;
  const arpOsc = ctxAudio.createOscillator();
  arpOsc.type = 'sawtooth';
  arpOsc.frequency.value = arpNotes[arpIndex];
  arpOsc.connect(arpGain);
  arpOsc.start();
  const arpTimer = setInterval(() => {
    arpIndex = (arpIndex + 1) % arpNotes.length;
    arpOsc.frequency.setValueAtTime(arpNotes[arpIndex], ctxAudio.currentTime);
  }, 400);
  audio.layers.push({
    stop: () => {
      clearInterval(arpTimer);
      fadeStop(arpOsc, arpGain);
    },
  });

  const noise = ctxAudio.createBufferSource();
  const buffer = ctxAudio.createBuffer(1, ctxAudio.sampleRate * 2, ctxAudio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
  }
  noise.buffer = buffer;
  noise.loop = true;
  const noiseFilter = ctxAudio.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 2000;
  noiseFilter.Q.value = 2;
  const noiseGain = ctxAudio.createGain();
  noiseGain.gain.value = 0.04;
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(master);
  noise.start();
  audio.layers.push({ stop: () => fadeStop(noise, noiseGain) });
}

/**
 * Fades out and stops an oscillator
 * @param {OscillatorNode} osc - Oscillator to stop
 * @param {GainNode} gain - Gain node for fade out
 */
function fadeStop(osc, gain) {
  const ctxAudio = audio.ctx;
  if (!ctxAudio) return;
  const now = ctxAudio.currentTime;
  if (gain && gain.gain) gain.gain.linearRampToValueAtTime(0.0001, now + 1);
  setTimeout(() => {
    try {
      osc.stop();
    } catch (e) {}
  }, 1100);
}

function stopSoundtrack() {
  if (!audio.ctx) return;
  audio.layers.forEach(layer => {
    try {
      layer.stop();
    } catch (e) {}
  });
  audio.layers = [];
  audio.running = false;
}

// ============================================================================
// INPUT HANDLING
// ============================================================================

/**
 * Gets horizontal input direction from arrow keys or WASD
 * @returns {number} -1 (left), 0 (neutral), or 1 (right)
 */
function horizontalInput() {
  let dir = 0;
  if (keys.has('ArrowRight') || keys.has('KeyD')) dir += 1;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) dir -= 1;
  return dir;
}

/**
 * Gets vertical input direction from arrow keys
 * @returns {number} -1 (up), 0 (neutral), or 1 (down)
 */
function verticalInput() {
  let dir = 0;
  if (keys.has('ArrowDown')) dir += 1;
  if (keys.has('ArrowUp')) dir -= 1;
  return dir;
}

/**
 * Checks if the crouch key is pressed (S)
 * @returns {boolean}
 */
function crouchInput() {
  return keys.has('KeyS');
}

/**
 * Checks if the sprint key is pressed (Shift)
 * @returns {boolean}
 */
function sprintInput() {
  return keys.has('ShiftLeft') || keys.has('ShiftRight');
}

// ============================================================================
// PLAYER ANIMATION
// ============================================================================

/**
 * Updates player animation state and frame
 * @param {string} targetState - Target animation state
 * @param {number} dt - Delta time in seconds
 */
function updatePlayerAnimation(targetState, dt) {
  if (player.anim.state !== targetState) {
    player.anim.state = targetState;
    player.anim.frame = 0;
    player.anim.timer = 0;
  }
  const frameCount = getFrameCount(player.sprite, targetState);
  if (frameCount <= 1) return;
  const speed = ANIM_SPEED[targetState] || 0.3;
  player.anim.timer += dt;
  if (player.anim.timer >= speed) {
    player.anim.timer = 0;
    player.anim.frame = (player.anim.frame + 1) % frameCount;
  }
}

/**
 * Gets the number of frames in an animation state
 * @param {string} name - Character sprite set name
 * @param {string} state - Animation state
 * @returns {number} Number of frames
 */
function getFrameCount(name, state) {
  const set = SPRITES[name];
  if (!set) return 0;
  const frames = set[state] || set.idle || [];
  return frames.length;
}

// ============================================================================
// KEYBOARD EVENT LISTENERS
// ============================================================================

document.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'KeyS', 'KeyW', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
    keys.add(e.code);
    startSoundtrack();
    if (e.code === 'KeyW') {
      player.lookUpTimer = 1.2;
    }
  }
  if ((e.code === 'Space' || e.code === 'KeyZ') && !e.repeat) {
    if (dialogue.active) {
      advanceDialogue();
    } else {
      attemptInteract();
    }
    e.preventDefault();
  }
  // DEBUG: Press U to manually unfreeze player
  if (e.code === 'KeyU' && !e.repeat) {
    player.frozen = false;
    console.log('DEBUG: Player manually unfrozen');
  }
});

document.addEventListener('keyup', (e) => {
  keys.delete(e.code);
});

// ============================================================================
// SPRITE CREATION & DEFINITION
// ============================================================================

/**
 * Creates all sprite definitions from palette-encoded pixel data
 */
function createSprites() {
  const palette = {
    '.': null,
    'o': '#000000', // outline
    's': '#ffe7d5', // skin
    'l': '#fff6eb', // highlights
    'd': '#7488c2', // mid cloth
    'g': '#7effe4', // lumen glow
    'h': '#19253d', // hood / hair
    'b': '#304466', // coat body
    't': '#1f2c3f', // trousers
    'p': '#b2dff1', // patches
    'a': '#111827', // accessory dark
    'y': '#ffd86f', // key gold
  };

  const sprite = rows => {
    const h = rows.length;
    const w = rows[0].length;
    const pixels = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        pixels.push(palette[rows[y][x]] || null);
      }
    }
    return { w, h, pixels };
  };

  // Luis Alejandro Moreno - main character, has Lumen glow in his veins
  const luisFrames = {
    idle: [
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.obbt..tbbbo...',
        '..oo....ooo....',
      ],
      // Add breathing animation
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...', // Slightly more glow
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        '.obbt..tbbbo...',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
    ],
    walk: [
      // Frame 1 - left foot forward
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.obbt..tbbbo...',
        '..oo....ooo....',
      ],
      // Frame 2 - center
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      // Frame 3 - right foot forward
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        '.obbt..tbbbo...',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      // Frame 4 - center again
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
    ],
    sprint: [
      // Frame 1 - leaning forward, left leg extended
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '.ohbbbbbbbbho..',
        '.obbtttttbbbo..',
        '.obbt..tbbbo...',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      // Frame 2 - mid-stride
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '.ohbbbbbbbbho..',
        '.ohbbbbbbbbho..',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.obbt..tbbbo...',
        '..oo....ooo....',
      ],
      // Frame 3 - right leg extended
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '..hbbbbbbbb....',
        '.ohbbbbbbbbho..',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.obbt..tbbbo...',
        '..oo....ooo....',
      ],
      // Frame 4 - recovery
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '..ohhhhhhhho...',
        '.ohbbbbbbbbho..',
        '.ohbbgggbbho...',
        '.ohbgggggbho...',
        '.ohbbgggbbho...',
        '..hbbgggbbh....',
        '.ohbbbbbbbbho..',
        '..hbbbbbbbb....',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
    ],
    crouch: [
      [
        '....ooooooo....',
        '...ohhhhhhh....',
        '..ohsssslsho...',
        '..ohsssslsho...',
        '..ohshssshho...',
        '.oohhhhhhhho...',
        '.oohbbbbbbho...',
        '.oohbbggbho....',
        '.oohbbggbho....',
        '.oohbbggbho....',
        '..hhbbbbbh.....',
        '..hhbbbbbh.....',
        '..hhbbbbbh.....',
        '.obbbbbbbbbo...',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
    ],
  };

  const adrianFrames = {
    sleep: [
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbpppbbhho.',
        '.ohbbpppbbhho.',
        '..hbbbbbbbbh...',
        '.ohbbbbbbbbho..',
        '.ohbbbbbbbbho..',
        '.obbtttttbbbo..',
        'obbttttttbbbo..',
        '.oo......ooo...',
      ],
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbpppbbhho.',
        '.ohbbpppbbhho.',
        '.ohbbbbbbbbho..',
        '.ohbbbbbbbbho..',
        '..hbbbbbbbbh...',
        '.obbtttttbbbo..',
        'obbttttttbbbo..',
        '.oo......ooo...',
      ],
      // Add breathing while asleep
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbpppbbhho.',
        '.ohbbpppbbhho.',
        '..hbbbbbbbbh...',
        '.ohbbbbbbbbho..',
        '.ohbbbbbbbbho..',
        '.obbtttttbbbo..',
        'obbttttttbbbo..',
        '.oo......ooo...',
      ],
    ],
    idle: [
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbpppbbhho.',
        '.ohbbpppbbhho.',
        '..hbbbbbbbbh...',
        '..hbbbbbbbbh...',
        '..hbbbbbbbbh...',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbpppbbhho.',
        '.ohbbpppbbhho.',
        '..hbbbbbbbbh...',
        '..hbbbbbbbbh...',
        '..hbbbbbbbbh...',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.obbt..tbbbo...',
        '..oo....ooo....',
      ],
      // Add subtle head movement
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbpppbbhho.',
        '.ohbbpppbbhho.',
        '.ohbbbbbbbbho..',
        '..hbbbbbbbbh...',
        '..hbbbbbbbbh...',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
    ],
    wake: [
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbpppbbhho.',
        '.ohbbpppbbhho.',
        '.ohbbbbbbbbho..',
        '.ohbbbbbbbbho..',
        '.ohbbbbbbbbho..',
        '.obbtttttbbbo..',
        '.obbt..tbbbo...',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '.oohhhhhhho...',
        '.oohbbbbbbho...',
        '.oohbbppbho....',
        '.oohbbppbho....',
        '.oohbbppbho....',
        '..hhbbbbbh.....',
        '..hhbbbbbh.....',
        '..hhbbbbbh.....',
        '.obbbbbbbbbo...',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssssto...',
        '..ohsssssto...',
        '..ohsssslho...',
        '.oohhhhhhho...',
        '.oohbbbbbbho...',
        '.oohbbppbho....',
        '.oohbbppbho....',
        '.oohbbppbho....',
        '.ohbbbbbbbbho..',
        '.ohbbbbbbbbho..',
        '..hbbbbbbbbh...',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
    ],
  };

  const maeFrames = {
    idle: [
      [
        '....oooooo....',
        '...ohhhhhh....',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbppppbbho..',
        '..hbbbbbbbh...',
        '..hbbbbbbbh...',
        '..hbbbbbbbh...',
        '.obbtttttbbbo.',
        'obbt....tbbbo.',
        '.oo......ooo..',
      ],
      [
        '....oooooo....',
        '...ohhhhhh....',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbppppbbho..',
        '..hbbbbbbbh...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.obbtttttbbbo.',
        'obbt....tbbbo.',
        '.oo......ooo..',
      ],
      // Add gentle sway
      [
        '....oooooo....',
        '...ohhhhhh....',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbppppbbho..',
        '..hbbbbbbbh...',
        '..hbbbbbbbh...',
        '.ohbbbbbbbho..',
        '.obbtttttbbbo.',
        'obbt....tbbbo.',
        '.oo......ooo..',
      ],
    ],
  };

  const rheaFrames = {
    idle: [
      [
        '....oooo....',
        '...ohhho...',
        '..ohsssho..',
        '..ohsssho..',
        '..ohsssho..',
        '..ohhhho...',
        '.ohbbbbho..',
        '.ohbbbbho..',
        '.ohbbbbho..',
        '..hbbbbh...',
        '..hbbbbh...',
        '.obbttbbo..',
        'obbt..tbbo.',
        '.oo....oo..',
      ],
      [
        '....oooo....',
        '...ohhho...',
        '..ohsssho..',
        '..ohsssho..',
        '..ohsssho..',
        '..ohhhho...',
        '.ohbbbbho..',
        '.ohbbbbho..',
        '.ohbbbbho..',
        '..hbbbbh...',
        '.ohbbbbho..',
        '.obbttbbo..',
        'obbt..tbbo.',
        '.oo....oo..',
      ],
      // Add subtle breathing
      [
        '....oooo....',
        '...ohhho...',
        '..ohsssho..',
        '..ohsssho..',
        '..ohsssho..',
        '..ohhhho...',
        '.ohbbbbho..',
        '.ohbbbbho..',
        '.ohbbbbho..',
        '..hbbbbh...',
        '..hbbbbh...',
        '.obbttbbo..',
        'obbt..tbbo.',
        '.oo....oo..',
      ],
    ],
  };

  const tannerFrames = {
    idle: [
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbtttbbhho.',
        '..hbbbbbbbbh...',
        '..hbbbbbbbbh...',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.obbt..tbbbo...',
        '..oo....ooo....',
      ],
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbtttbbhho.',
        '..hbbbbbbbbh...',
        '.ohbbbbbbbbho..',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.oo......ooo...',
      ],
      // Add head tilt variation
      [
        '....ooooooo....',
        '...ohhhhhto...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohsssslho...',
        '..ohhhhhhho...',
        '.ohbbbbbbbbho.',
        '.ohbbbbbbbbho.',
        '.ohbbtttbbhho.',
        '..hbbbbbbbbh...',
        '..hbbbbbbbbh...',
        '.obbtttttbbbo..',
        'obbt....tbbbo..',
        '.obbt..tbbbo...',
        '..oo....ooo....',
      ],
    ],
  };

  const note = sprite([
    '..llllll..',
    '.lsllllls.',
    '.lsllllls.',
    '.lsllllls.',
    '.lsllllls.',
    '..llllll..',
  ]);

  const doorLocked = sprite([
    '..oooooo..',
    '.oodddddo.',
    '.oddddddo.',
    '.odddaddo.',
    '.oddddddo.',
    '.oddddddo.',
    '.oddddddo.',
    '.oodddddo.',
    '..oooooo..',
  ]);

  const doorUnlocked = sprite([
    '..oooooo..',
    '.oo....oo.',
    '.o......o.',
    '.o......o.',
    '.o......o.',
    '.o......o.',
    '.o......o.',
    '.oo....oo.',
    '..oooooo..',
  ]);

  const key = sprite([
    '...oooo...',
    '..oyyyo...',
    '..oyyyo...',
    '.oyyyyyo..',
    'oyyyyyyyo.',
    '.oyyyo....',
    '..oyo.....',
    '..oyo.....',
    '..oooo....',
  ]);

  return {
    luis: mapFrames(luisFrames, sprite),
    adrian: mapFrames(adrianFrames, sprite),
    mae: mapFrames(maeFrames, sprite),
    rhea: mapFrames(rheaFrames, sprite),
    tanner: mapFrames(tannerFrames, sprite),
    note,
    door_locked: doorLocked,
    door_unlocked: doorUnlocked,
    key_item: key,
  };

  function mapFrames(config, make) {
    const out = {};
    for (const [state, frames] of Object.entries(config)) {
      out[state] = frames.map(make);
    }
    return out;
  }
}

// ============================================================================
// DIALOGUE SYSTEM
// ============================================================================

/**
 * Displays dialogue text with optional auto-advance
 * @param {string|string[]} lines - Dialogue line(s) to display
 * @param {Function} onComplete - Callback when dialogue finishes
 * @param {Object} options - Configuration (auto, delay)
 */
function showDialogue(lines, onComplete, options = {}) {
  dialogue.queue = Array.isArray(lines) ? [...lines] : [lines];
  dialogue.onComplete = onComplete || null;
  dialogue.active = true;
  dialogue.auto = !!options.auto;
  dialogue.autoDelay = options.delay || 2.5;
  dialogue.autoTimer = dialogue.auto ? dialogue.autoDelay : 0;
  dialogueBox.classList.remove('hidden');
  dialogueText.textContent = dialogue.queue.shift();
}

/**
 * Advances to the next dialogue line or closes the dialogue box
 */
function advanceDialogue() {
  if (!dialogue.active) return;
  if (dialogue.queue.length > 0) {
    dialogueText.textContent = dialogue.queue.shift();
    if (dialogue.auto) dialogue.autoTimer = dialogue.autoDelay;
  } else {
    dialogue.active = false;
    dialogueBox.classList.add('hidden');
    dialogue.auto = false;
    if (dialogue.onComplete) dialogue.onComplete();
  }
}

/**
 * Updates the inventory display UI
 */
function updateInventory() {
  if (inventoryEl) {
    const keyStatus = state.flags.sol_key ? '✓' : '—';
    inventoryEl.textContent = `Notes: ${inventory.length} | Key: ${keyStatus}`;
  }
}

// ============================================================================
// SCENE MANAGEMENT
// ============================================================================

/**
 * Transitions to a named scene (prologue, house, rooftop, relay)
 * @param {string} name - Scene name to load
 */
function setScene(name) {
  state.scene = name;
  player.dir = 0;
  player.crouch = false;
  player.lookUpTimer = 0;
  if (name === 'prologue') {
    player.visible = false;
    player.frozen = true;
    showDialogue(
      [
        'After midnight, the city remembers how to glow.',
        'Adrian: “Do you feel it?”',
        'Lois: “It won’t stop.”',
      ],
      () => fadeTo(() => setScene('planetarium')),
      { auto: true, delay: 2.5 }
    );
  } else if (name === 'planetarium') {
    state.map = JSON.parse(JSON.stringify(maps.planetarium));
    // Add doors to rooms
    setMapTile(state.map, 8, 3, 'D');  // Door to left room (Mae)
    setMapTile(state.map, 8, 6, 'D');  // Door to left room bottom
    setMapTile(state.map, 24, 3, 'D'); // Door to right room (Rhea)
    setMapTile(state.map, 24, 6, 'D'); // Door to right room bottom
    setMapTile(state.map, 14, 9, 'D'); // Door to center room (Adrian)
    setMapTile(state.map, 14, 13, 'D'); // Door to center room bottom
    
    player.x = 10 * TILE;
    player.y = 2 * TILE;
    player.visible = true;
    player.frozen = true;
    state.entities = createPlanetariumEntities();
    syncFollowersToPlayer();
    
    showDialogue(
      [
        'Chapter 1 — The Glow',
        'The planetarium dome still remembers starlight through the glow.',
        'Find Mae, Rhea, and Tanner. Bring them into the fold.',
      ],
      () => {
        player.frozen = false;
      },
      { auto: true, delay: 2.4 }
    );
  } else if (name === 'house') {
    state.map = JSON.parse(JSON.stringify(maps.house));
    // ensure hallway doors exist on map
    setMapTile(state.map, 11, 3, 'D'); // Adrian doorway
    setMapTile(state.map, 12, 3, '.');
    setMapTile(state.map, 15, 9, 'D'); // Front door tile
    player.x = 12 * TILE + TILE / 2;
    player.y = 9 * TILE;
    player.visible = true;
    player.frozen = true;
    state.entities = createHouseEntities();
    [[4,3],[7,3]].forEach(([tx,ty]) => setMapTile(state.map, tx, ty, '.'));
    state.followers = [];
    syncFollowersToPlayer();
    showDialogue(
      [
        'Chapter 0 — Wake.',
        'The safe house hums with Solvine light and anxious breaths.',
        'Find Adrian. Gather the key. Step into the glow together.',
      ],
      () => {
        player.frozen = false;
      },
      { auto: true, delay: 2.4 }
    );
  } else if (name === 'rooftop') {
    state.map = JSON.parse(JSON.stringify(maps.rooftop));
    player.x = 10 * TILE; // Open area in the middle
    player.y = 2 * TILE;  // Top open area
    player.visible = true;
    player.frozen = true; // Start frozen during dialogue
    state.entities = createRooftopEntities();
    syncFollowersToPlayer();
    showDialogue(
      [
        'Chapter 2 — Static Gardens',
        'Hydroponic tarps snap in the wind. The relay tower glows in the distance.',
        'Check in with Mae, Rhea, and Tanner before the climb.',
      ],
      () => {
        player.frozen = false; // Unfreeze after dialogue
      },
      { auto: true, delay: 2.8 }
    );
  } else if (name === 'relay') {
    state.map = JSON.parse(JSON.stringify(maps.relay));
    player.x = 10 * TILE; // Center open area
    player.y = 2 * TILE;  // Top open area
    player.visible = true;
    player.frozen = true; // Start frozen during dialogue
    state.entities = createRelayEntities();
    state.followers = state.followers.filter(f => f.id === 'adrian_follower');
    if (state.followers.length === 0 && state.flags.adrian_follow) {
      addFollower('adrian_follower', 'adrian');
    } else {
      syncFollowersToPlayer();
    }
    showDialogue(
      [
        'Chapter 3 — The Bright Silence',
        'The relay vault hums too bright for the city to dream.',
        'Only you and Adrian descend into the core.',
      ],
      () => {
        player.frozen = false; // Unfreeze after dialogue
      },
      { auto: true, delay: 2.5 }
    );
  } else if (name === 'afterlight') {
    player.visible = false;
    player.frozen = true;
    state.map = null;
    state.entities = [];
    state.followers = [];
    state.playerPath = [];
    showDialogue(
      [
        'Chapter 5 — Afterlight',
        'The glow yields. The city rests in a quiet penumbra.',
        'Luis: “We made a night they can sleep through.”',
        'Adrian: “And we stay to keep it.”',
        'Thank you for guiding Project Deathbed.',
      ],
      null,
      { auto: true, delay: 3.2 }
    );
  }
}

// ============================================================================
// ENTITY CREATION
// ============================================================================

/**
 * Creates all interactable entities for the planetarium scene (Chapter 1)
 * @returns {Array} Array of entity objects
 */
function createPlanetariumEntities() {
  const entities = [];

  const planetariumDoors = [
    { id: 'door_left_top', tile: { x: 8, y: 3 } },
    { id: 'door_left_bottom', tile: { x: 8, y: 6 } },
    { id: 'door_right_top', tile: { x: 24, y: 3 } },
    { id: 'door_right_bottom', tile: { x: 24, y: 6 } },
    { id: 'door_center_top', tile: { x: 14, y: 9 } },
    { id: 'door_center_bottom', tile: { x: 14, y: 13 } },
  ];

  for (const door of planetariumDoors) {
    entities.push({
      id: door.id,
      type: 'door',
      sprite: 'door_unlocked',
      locked: false,
      x: door.tile.x * TILE + TILE / 2,
      y: door.tile.y * TILE + TILE / 2,
      w: TILE,
      h: TILE,
      tile: { x: door.tile.x, y: door.tile.y },
      text: ['You peel back the taped seam.'],
    });
  }

  entities.push({
    id: 'mae_planetarium',
    type: 'npc',
    spriteSet: 'mae',
    x: 6 * TILE + TILE / 2,
    y: 5 * TILE + TILE / 2,
    animOffset: 0.2,
    joinOnTalk: true,
    followerId: 'mae_follower',
    flag: 'talk_mae_planetarium',
    text: [
      'Mae: “Mask up. Double-check the seals. Lumen loves lungs.”',
      'Mae: “You hold the count, I’ll hold the line.”',
    ],
  });

  entities.push({
    id: 'rhea_planetarium',
    type: 'npc',
    spriteSet: 'rhea',
    x: 20 * TILE + TILE / 2,
    y: 12 * TILE + TILE / 2,
    animOffset: 0.45,
    joinOnTalk: true,
    followerId: 'rhea_follower',
    flag: 'talk_rhea_planetarium',
    text: [
      'Rhea chalked a circle that reads HOME, the letters reversed but true.',
      'Rhea: “We’ll keep the glow outside this line. Promise.”',
    ],
  });

  entities.push({
    id: 'tanner_planetarium',
    type: 'npc',
    spriteSet: 'tanner',
    x: 14 * TILE + TILE / 2,
    y: 11 * TILE + TILE / 2,
    animOffset: 0.1,
    joinOnTalk: true,
    followerId: 'tanner_follower',
    flag: 'talk_tanner_planetarium',
    text: [
      'Tanner: “Catwalks are rusted but I still remember which ones sing.”',
      'Tanner: “Relay’s our next stop. Static Gardens first, then we cut the bloom.”',
    ],
  });

  entities.push({
    id: 'planetarium_exit',
    type: 'exit',
    x: 31 * TILE,
    y: 15 * TILE,
    w: TILE,
    h: TILE * 2,
    textLocked: ['The door is sealed for now. Rally the whole crew.'],
    requires: ['talk_mae_planetarium', 'talk_rhea_planetarium', 'talk_tanner_planetarium'],
    textUnlocked: [
      'Chapter 2 — Static Gardens waits two levels up.',
      'Mae shoulders the filters. Rhea grabs chalk. Tanner taps the map twice.',
    ],
    nextScene: 'rooftop',
  });

  return entities;
}

/**
 * Creates all interactable entities for the house scene
 * @returns {Array} Array of entity objects
 */
function createHouseEntities() {
  const entities = [];
  // Mask note
  entities.push({
    id: 'note_mask',
    type: 'note',
    x: 5 * TILE + TILE / 2,
    y: 7 * TILE + TILE / 2,
    w: 12,
    h: 12,
    sprite: 'note',
    text: [
      'Mae scribbled: MASK UP.',
      'Double-check the seals. Lumen loves lungs.',
    ],
  });
  // Solvine note
  entities.push({
    id: 'note_solvine',
    type: 'note',
    x: 11 * TILE + TILE / 2,
    y: 4 * TILE + TILE / 2,
    w: 12,
    h: 12,
    sprite: 'note',
    text: [
      'Adrian’s log: Solvine bends the carrier frequency.',
      'Not enough stock. Need a miracle or a refinery run.',
    ],
  });
  // Front door
  entities.push({
    id: 'door_front',
    type: 'door',
    x: 15 * TILE + TILE / 2,
    y: 9 * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    sprite: 'door_locked',
    locked: true,
    requires: 'adrian_follow',
    tile: { x: 15, y: 9 },
    textLocked: ['Adrian: “We go together.”', 'Rouse him before you leave.'],
    textUnlocked: [
      'The front door seal sighs loose.',
      'Chapter 1 — The Glow waits in the planetarium dome.',
    ],
    nextScene: 'planetarium',
  });
  // Adrian
  entities.push({
    id: 'adrian',
    type: 'npc',
    spriteSet: 'adrian',
    x: 13 * TILE + TILE / 2,
    y: 3 * TILE + TILE / 2,
    animOffset: 0.2,
    role: 'adrian',
    text: [
      'Adrian is sleeping under Solvine light.',
      'Maybe he dreams about shutting down the relay.',
    ],
    awake: false,
  });
  entities.push({
    id: 'door_lois',
    type: 'door',
    x: 4 * TILE + TILE / 2,
    y: 3 * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    sprite: 'door_unlocked',
    locked: false,
    text: ['Lois taped this doorway with quiet hands.'],
  });

  entities.push({
    id: 'door_adrian',
    type: 'door',
    x: 11 * TILE + TILE / 2,
    y: 3 * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    sprite: 'door_locked',
    locked: true,
    requires: 'sol_key',
    tile: { x: 11, y: 3 },
    textLocked: ['Adrian keeps this sealed.', 'Need the Solvine key.'],
    textUnlocked: ['The door unlatches softly.'],
  });
  entities.push({
    id: 'door_adrian_inner',
    type: 'door',
    x: 12 * TILE + TILE / 2,
    y: 3 * TILE + TILE / 2,
    w: TILE,
    h: TILE,
    sprite: 'door_unlocked',
    locked: false,
    text: ['Inside Adrian’s room.'],
  });

  entities.push({
    id: 'sol_key',
    type: 'key',
    x: 8 * TILE + TILE / 2,
    y: 6 * TILE + TILE / 2,
    w: 12,
    h: 12,
    sprite: 'key_item',
    text: [
      'You found the Solvine key.',
      'It hums with a soft photonic pulse.',
    ],
  });

  return entities;
}

/**
 * Creates all interactable entities for the rooftop scene
 * @returns {Array} Array of entity objects
 */
function createRooftopEntities() {
  const baseY = 6 * TILE;
  return [
    {
      id: 'mae_npc',
      type: 'npc',
      spriteSet: 'mae',
      x: 6 * TILE + TILE / 2,
      y: baseY,
      animOffset: 0,
      text: [
        'Mae: “We keep the little ones breathing by counting.”',
        'Mae: “You look steadier than yesterday.”',
      ],
      flag: 'talk_mae',
    },
    {
      id: 'rhea_npc',
      type: 'npc',
      spriteSet: 'rhea',
      x: 11 * TILE + TILE / 2,
      y: baseY - TILE,
      animOffset: 0.3,
      text: [
        'Rhea: “Do you think the glow hums when no one listens?”',
        'Rhea: “I drew Tanner a map. Want to see?”',
      ],
      flag: 'talk_rhea',
    },
    {
      id: 'tanner_npc',
      type: 'npc',
      spriteSet: 'tanner',
      x: 17 * TILE,
      y: baseY + TILE,
      animOffset: 0.6,
      text: [
        'Tanner: “Catwalks died, but I still know where to step.”',
        'Tanner: “Relay’s burning bright. We hit it tonight.”',
      ],
      flag: 'talk_tanner',
    },
    {
      id: 'exit_rooftop',
      type: 'exit',
      x: 12 * TILE,
      y: 11 * TILE,
      w: TILE,
      h: TILE,
      textLocked: ['Mae: “Talk to everyone before we go.”'],
      requires: ['talk_mae', 'talk_rhea', 'talk_tanner'],
      textUnlocked: [
        'Mae: “Relay vault in three breaths. We hold the garden.”',
        'Tanner: “Luis, Adrian—slice the core. We’ll cover the retreat.”',
      ],
      nextScene: 'relay',
    },
  ];
}

/**
 * Creates all interactable entities for the relay scene
 * @returns {Array} Array of entity objects
 */
function createRelayEntities() {
  return [
    {
      id: 'relay_core',
      type: 'star',
      x: 12 * TILE,
      y: 5 * TILE,
      w: 16,
      h: 16,
      text: [
        'Adrian: “Solvine threads the light back on itself.”',
        'Mae: “Do it. Before the glow learns another song.”',
      ],
      finale: [
        'Chapter 3 — The Bright Silence.',
        'Solvine floods the relay core; light implodes into a hush.',
        'Mae and Rhea hold the seals while Tanner cuts the feeds.',
        'Chapter 4 — The Penumbra Vault.',
        'Adrian turns the final dial. Luis steadies the resonance.',
        'The city breathes out—a darker, safer night settles.',
      ],
      afterScene: 'afterlight',
    },
  ];
}

// ============================================================================
// SCREEN TRANSITIONS
// ============================================================================

/**
 * Triggers a fade-to-black transition
 * @param {Function} cb - Callback to execute when fade is complete
 */
function fadeTo(cb) {
  state.fadeTarget = 1;
  state.fadeCallback = () => {
    if (cb) cb();
    state.fadeTarget = 0;
  };
}

// ============================================================================
// INTERACTION SYSTEM
// ============================================================================

/**
 * Attempts to interact with a nearby entity
 * @returns {boolean} True if an interaction was found and handled
 */
function attemptInteract() {
  const range = 18;
  for (const entity of state.entities || []) {
    const dx = (player.x) - entity.x;
    const dy = (player.y) - entity.y;
    if (Math.hypot(dx, dy) < range) {
      handleInteraction(entity);
      return true;
    }
  }
  return false;
}

/**
 * Handles interaction with a specific entity
 * @param {Object} entity - Entity to interact with
 */
function handleInteraction(entity) {
  if (entity.role === 'adrian') {
    handleAdrian(entity);
  } else if (entity.type === 'note') {
    showDialogue(entity.text, () => collectNote(entity));
  } else if (entity.type === 'door') {
    handleDoorInteraction(entity);
  } else if (entity.type === 'key') {
    collectKey(entity);
  } else if (entity.type === 'npc') {
    showDialogue(entity.text, () => {
      if (entity.flag) state.flags[entity.flag] = true;
      
      if (entity.joinOnTalk && entity.spriteSet) {
        const followerId = entity.followerId || entity.id;
        addFollower(followerId, entity.spriteSet);
        entity.collected = true;
        state.entities = state.entities.filter(e => e.id !== entity.id);
      }
    });
  } else if (entity.type === 'exit') {
    const needs = entity.requires || [];
    const met = needs.every(flag => state.flags[flag]);
    if (!met) {
      showDialogue(entity.textLocked || ['Not yet.']);
    } else {
      showDialogue(entity.textUnlocked || ['Moving on.'], () => {
        if (entity.nextScene) setScene(entity.nextScene);
      });
    }
  } else if (entity.type === 'star') {
    showDialogue(entity.text || ['It vibrates.'], () => {
      showDialogue(entity.finale || ['The glow quiets.'], () => {
        stopSoundtrack();
        state.flags.demoComplete = true;
        if (entity.afterScene) {
          fadeTo(() => setScene(entity.afterScene));
        }
      });
    });
  }
}

/**
 * Collects a note item into inventory
 * @param {Object} entity - Note entity to collect
 */
function collectNote(entity) {
  if (inventory.includes(entity.id)) return;
  inventory.push(entity.id);
  updateInventory();
  entity.collected = true;
  state.entities = (state.entities || []).filter(e => !e.collected);
}

/**
 * Collects a key item and unlocks associated doors
 * @param {Object} entity - Key entity to collect
 */
function collectKey(entity) {
  if (state.flags[entity.id]) {
    showDialogue(['Already pocketed.']);
    return;
  }
  state.flags[entity.id] = true;
  state.flags.sol_key = true;
  updateInventory();
  entity.collected = true;
  state.entities = (state.entities || []).filter(e => !e.collected);
  showDialogue(entity.text || ['Key acquired.']);
}

/**
 * Handles door interaction - checks locks and performs transitions
 * @param {Object} entity - Door entity
 */
function handleDoorInteraction(entity) {
  if (entity.locked) {
    if (entity.requires && state.flags[entity.requires]) {
      entity.locked = false;
      entity.sprite = 'door_unlocked';
      if (entity.tile) setMapTile(state.map, entity.tile.x, entity.tile.y, '.');
      showDialogue(entity.textUnlocked || ['The lock releases.']);
    } else {
      showDialogue(entity.textLocked || entity.text || ['Locked tight.']);
    }
  } else {
    // Unlocked door - open it
    if (entity.tile) setMapTile(state.map, entity.tile.x, entity.tile.y, '.');
    // Remove the door entity so it can't be interacted with again
    entity.collected = true;
    state.entities = state.entities.filter(e => e.id !== entity.id);
    
    const lines = entity.textUnlocked || entity.text || ['The doorway yawns open.'];
    if (entity.nextScene) {
      showDialogue(lines, () => {
        setScene(entity.nextScene);
      });
    } else if (lines) {
      showDialogue(lines);
    }
  }
}

/**
 * Special handler for Adrian NPC interactions
 * @param {Object} entity - Adrian entity
 */
function handleAdrian(entity) {
  if (!entity.awake) {
    entity.awake = true;
    entity.animState = 'wake';
    state.flags.adrian_follow = true;
    player.frozen = true;
    showDialogue(
      [
        'Adrian blinks awake beneath Solvine light.',
        'Adrian: “We pin the relay, we give the city a night to breathe.”',
        'Luis: “Then we move. Together.”',
      ],
      () => {
        addFollower('adrian_follower', 'adrian');
        entity.collected = true;
        state.entities = state.entities.filter(e => e.id !== entity.id);
        player.frozen = false;
      }
    );
  } else {
    showDialogue(
      entity.text || [
        'Adrian: “Check the seals, grab the Solvine key, then we head for the planetarium.”',
      ]
    );
  }
}

// ============================================================================
// GAME PHYSICS & MOVEMENT
// ============================================================================

/**
 * Core game update loop - handles input, animation, state changes
 * @param {number} dt - Delta time since last frame in seconds
 */
function update(dt) {
  state.time += dt;
  if (dialogue.active && dialogue.auto) {
    dialogue.autoTimer -= dt;
    if (dialogue.autoTimer <= 0) {
      advanceDialogue();
    }
  }
  const fadeSpeed = 1.5;
  if (Math.abs(state.fade - state.fadeTarget) > 0.01) {
    state.fade += Math.sign(state.fadeTarget - state.fade) * dt * fadeSpeed;
    state.fade = Math.max(0, Math.min(1, state.fade));
    if (Math.abs(state.fade - state.fadeTarget) <= 0.02) {
      state.fade = state.fadeTarget;
      if (state.fade === 1 && state.fadeCallback) {
        const cb = state.fadeCallback;
        state.fadeCallback = null;
        cb();
      }
    }
  }

  // Handle player movement in all playable scenes
  const playableScenes = ['planetarium', 'house', 'rooftop', 'relay'];
  if (playableScenes.includes(state.scene) && !player.frozen) {
    player.dirX = horizontalInput();
    player.dirY = verticalInput();
    player.crouch = crouchInput();
    player.sprinting = sprintInput() && (player.dirX !== 0 || player.dirY !== 0) && !player.crouch;
    const speed = player.crouch ? player.speed * 0.5 : player.sprinting ? player.speed * 1.6 : player.speed;
    movePlayer(player.dirX * speed * dt, player.dirY * speed * dt);
    if (player.lookUpTimer > 0) {
      player.lookUpTimer = Math.max(0, player.lookUpTimer - dt);
    }
    let animState = 'idle';
    if (player.dirX !== 0 || player.dirY !== 0) {
      animState = player.sprinting ? 'sprint' : 'walk';
    }
    if (player.crouch) animState = 'crouch';
    updatePlayerAnimation(animState, dt);
    
    // Update followers to follow the player
    updateFollowers(dt);
  } else {
    updatePlayerAnimation('idle', dt);
  }
}

/**
 * Moves the player, handling collision detection
 * @param {number} dx - Delta x movement
 * @param {number} dy - Delta y movement
 */
function movePlayer(dx, dy) {
  const map = state.map;
  if (!map) return;
  
  const oldX = player.x;
  const oldY = player.y;
  
  const nextX = player.x + dx;
  const nextY = player.y + dy;
  if (!isBlocked(nextX, player.y)) player.x = nextX;
  if (!isBlocked(player.x, nextY)) player.y = nextY;
  
  if (!Array.isArray(state.playerPath)) {
    state.playerPath = [];
  }
  if (state.playerPath.length === 0) {
    state.playerPath.push({ x: oldX, y: oldY });
  }
  
  // Record player position for followers to follow (only if player actually moved)
  if (player.x !== oldX || player.y !== oldY) {
    state.playerPath.push({ x: player.x, y: player.y });
    // Keep only last 300 positions to prevent memory issues
    if (state.playerPath.length > 300) {
      state.playerPath.shift();
    }
  }
}

/**
 * Resets the stored player trail used by followers
 */
function resetFollowerTrail() {
  state.playerPath = [{ x: player.x, y: player.y }];
}

/**
 * Snaps followers near the player and restarts the trail
 */
function syncFollowersToPlayer() {
  resetFollowerTrail();
  const baseOffset = 22;
  state.followers.forEach((follower, index) => {
    const angle = Math.PI / 2 + index * 0.45;
    const distance = baseOffset + index * 6;
    follower.x = player.x - Math.cos(angle) * distance;
    follower.y = player.y + Math.sin(angle) * distance;
    follower.animState = 'idle';
    follower.animTime = 0;
    follower.frameIndex = 0;
  });
}

/**
 * Adds a follower if they are not already trailing the player
 * @param {string} id - Unique follower id
 * @param {string} sprite - Sprite name to render
 */
function addFollower(id, sprite) {
  if (!id || !sprite) return;
  if (!state.followers.some(f => f.id === id)) {
    state.followers.push({
      id,
      sprite,
      x: player.x,
      y: player.y,
      animState: 'idle',
      animTime: 0,
      frameIndex: 0,
    });
  }
  syncFollowersToPlayer();
}

/**
 * Updates follower positions to trail behind player
 * @param {number} dt - Delta time in seconds
 */
function updateFollowers(dt) {
  if (state.followers.length === 0 || state.playerPath.length === 0) return;
  
  const spacing = 25; // Distance in pixels between each follower
  
  for (let i = 0; i < state.followers.length; i++) {
    const follower = state.followers[i];
    
    // Calculate how far back in the path this follower should be
    const targetDistance = spacing * (i + 1);
    
    // Find the position in the player's path at this distance
    let accumulatedDistance = 0;
    let targetPos = null;
    
    for (let j = state.playerPath.length - 1; j > 0; j--) {
      const curr = state.playerPath[j];
      const prev = state.playerPath[j - 1];
      const segmentDist = Math.sqrt(
        Math.pow(curr.x - prev.x, 2) + Math.pow(curr.y - prev.y, 2)
      );
      
      if (accumulatedDistance + segmentDist >= targetDistance) {
        // This is the segment where our target is
        const remaining = targetDistance - accumulatedDistance;
        const ratio = remaining / segmentDist;
        targetPos = {
          x: prev.x + (curr.x - prev.x) * ratio,
          y: prev.y + (curr.y - prev.y) * ratio,
        };
        break;
      }
      
      accumulatedDistance += segmentDist;
    }
    
    if (!targetPos && state.playerPath.length > 0) {
      targetPos = state.playerPath[0];
    }
    // If we found a target position, move towards it
    if (targetPos) {
      const dx = targetPos.x - follower.x;
      const dy = targetPos.y - follower.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist > 1) {
        // Move towards target position
        const moveSpeed = 150; // Fast movement to catch up
        const moveAmount = Math.min(moveSpeed * dt, dist);
        follower.x += (dx / dist) * moveAmount;
        follower.y += (dy / dist) * moveAmount;
        
        // Update animation - walking
        follower.animState = 'walk';
        follower.animTime += dt;
        const speed = ANIM_SPEED.walk || 0.2;
        if (follower.animTime >= speed) {
          follower.animTime = 0;
          const frames = SPRITES[follower.sprite]?.walk || SPRITES[follower.sprite]?.idle || [];
          follower.frameIndex = (follower.frameIndex + 1) % Math.max(1, frames.length);
        }
      } else {
        // Close enough, just idle
        follower.animState = 'idle';
        follower.animTime += dt;
        const speed = ANIM_SPEED.idle || 0.6;
        if (follower.animTime >= speed) {
          follower.animTime = 0;
          const frames = SPRITES[follower.sprite]?.idle || [];
          follower.frameIndex = (follower.frameIndex + 1) % Math.max(1, frames.length);
        }
      }
    } else {
      // No path to follow yet, just idle at current position
      follower.animState = 'idle';
      follower.animTime += dt;
      const speed = ANIM_SPEED.idle || 0.6;
      if (follower.animTime >= speed) {
        follower.animTime = 0;
        const frames = SPRITES[follower.sprite]?.idle || [];
        follower.frameIndex = (follower.frameIndex + 1) % Math.max(1, frames.length);
      }
    }
  }
}

/**
 * Checks if a position is blocked by walls or doors
 * @param {number} px - X position
 * @param {number} py - Y position
 * @returns {boolean} True if blocked
 */
function isBlocked(px, py) {
  const map = state.map;
  if (!map) return false;
  const halfW = player.w / 2 - 2;
  const halfH = player.h / 2 - 2;
  const points = [
    { x: px - halfW, y: py - halfH },
    { x: px + halfW, y: py - halfH },
    { x: px - halfW, y: py + halfH },
    { x: px + halfW, y: py + halfH },
  ];
  return points.some(({ x, y }) => {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (ty < 0 || ty >= map.height || tx < 0 || tx >= map.width) return true;
    const tile = map.rows[ty][tx];
    return tile === '#' || tile === 'D';
  });
}

// ============================================================================
// RENDERING SYSTEM
// ============================================================================

/**
 * Core render function - draws all game elements to canvas
 */
function render() {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (state.scene === 'prologue') {
    renderPrologue();
  } else if (state.scene === 'planetarium') {
    renderMapScene(state.map);
  } else if (state.scene === 'house') {
    renderMapScene(state.map);
  } else if (state.scene === 'rooftop') {
    renderMapScene(state.map);
  } else if (state.scene === 'relay') {
    renderMapScene(state.map);
  } else if (state.scene === 'afterlight') {
    renderAfterlight();
  }

  // Render followers before player so player is on top
  for (const follower of state.followers) {
    const frame = getCharacterFrame(follower.sprite, follower.animState, follower.frameIndex);
    if (frame) {
      const baseX = Math.floor(follower.x - frame.w / 2);
      const baseY = Math.floor(follower.y - frame.h / 2);
      // drop shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(follower.x, follower.y + frame.h / 2 - 2, frame.w / 2, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      drawFrame(frame, baseX, baseY);
    }
  }

  if (player.visible) {
    const crouchOffset = player.crouch ? 2 : 0;
    const frame = getCharacterFrame(player.sprite, player.anim.state, player.anim.frame);
    if (frame) {
      const baseX = Math.floor(player.x - frame.w / 2);
      const baseY = Math.floor(player.y - frame.h / 2 + crouchOffset);
      // drop shadow
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.ellipse(player.x, player.y + frame.h / 2 - 2, frame.w / 2, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      drawFrame(frame, baseX, baseY);
    }
  }

  if (player.lookUpTimer > 0) {
    ctx.fillStyle = 'rgba(143,214,255,0.85)';
    ctx.font = '12px monospace';
    ctx.fillText('The dome breathes above.', 12, 22);
  }

  if (state.fade > 0) {
    ctx.fillStyle = `rgba(0,0,0,${state.fade})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

/**
 * Renders the prologue scene with animated background and characters
 */
function renderPrologue() {
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#01050c');
  grad.addColorStop(1, '#041124');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Distant city silhouettes
  ctx.fillStyle = '#020a15';
  for (let i = 0; i < 8; i++) {
    const x = i * 40 + (i % 2 === 0 ? 0 : 10);
    const h = 30 + (i % 3) * 10;
    ctx.fillRect(x, canvas.height - h - 20, 30, h);
  }

  const starX = canvas.width / 2;
  const starY = 40;
  const pulsate = 0.6 + 0.4 * Math.sin(state.time * 2.2);
  const radius = 20 + pulsate * 10;
  ctx.strokeStyle = `rgba(255,246,220,${0.4 + pulsate * 0.2})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(starX, starY, radius + i * 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(255,248,230,${0.9})`;
  ctx.beginPath();
  ctx.arc(starX, starY, 8 + pulsate * 4, 0, Math.PI * 2);
  ctx.fill();
  // Light rays
  ctx.strokeStyle = `rgba(138, 214, 255, 0.6)`;
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI * 2 * i) / 6 + state.time * 0.2;
    ctx.beginPath();
    ctx.moveTo(starX, starY);
    ctx.lineTo(starX + Math.cos(angle) * 120, starY + Math.sin(angle) * 80);
    ctx.stroke();
  }

  const luisFrame = getCharacterFrame('luis', 'idle', Math.floor(state.time / 0.6));
  const adrianFrame = getCharacterFrame('adrian', 'idle', Math.floor((state.time + 0.3) / 0.6));
  drawFrame(luisFrame, 240, 220);
  drawFrame(adrianFrame, 360, 220);
}

function renderAfterlight() {
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#07101e');
  grad.addColorStop(1, '#152639');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#9fdcff';
  ctx.font = '18px monospace';
  ctx.fillText('AFTERLIGHT', 26, 64);

  const lines = [
    'The relay sleeps. The city exhales.',
    'Luis and Adrian keep their watch in the newfound dusk.',
    'Thank you for guiding this chapter of Project Deathbed.',
  ];
  ctx.font = '12px monospace';
  lines.forEach((line, index) => {
    ctx.fillText(line, 26, 110 + index * 22);
  });
}

/**
 * Renders a map-based scene (house, rooftop, relay)
 * @param {Object} map - Map object with tile data
 */
function renderMapScene(map) {
  if (!map) return;
  const palette = SCENE_COLORS[state.scene] || COLORS;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const tile = map.rows[y][x];
      if (tile === '#') ctx.fillStyle = palette.wall || COLORS.wall;
      else if (tile === 'D') ctx.fillStyle = palette.door || COLORS.door;
      else ctx.fillStyle = palette.floor || COLORS.floor;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
      if (tile === 'D') {
        ctx.fillStyle = '#ced6f0';
        ctx.fillRect(x * TILE + 3, y * TILE + 3, TILE - 6, TILE - 6);
      }
    }
  }

  (state.entities || []).forEach((entity) => {
    if (entity.type === 'npc') {
      const frames = SPRITES[entity.spriteSet];
      const animState = entity.animState || 'idle';
      const baseFrames = frames ? frames[animState] || frames.idle : [];
      const frame =
        baseFrames && baseFrames.length
          ? baseFrames[Math.floor((state.time + (entity.animOffset || 0)) / 0.6) % baseFrames.length]
          : null;
      if (frame) drawFrame(frame, Math.floor(entity.x - frame.w / 2), Math.floor(entity.y - frame.h / 2));
    } else if (entity.sprite) {
      const sprite = SPRITES[entity.sprite];
      drawFrame(sprite, Math.floor(entity.x - sprite.w / 2), Math.floor(entity.y - sprite.h / 2));
    } else {
      ctx.fillStyle = COLORS.glow;
      ctx.fillRect(entity.x - 2, entity.y - 2, 4, 4);
    }
  });
}

// ============================================================================
// MAIN GAME LOOP & INITIALIZATION
// ============================================================================

let last = 0;

/**
 * requestAnimationFrame loop - main game loop
 * @param {number} ts - Timestamp from RAF
 */
function loop(ts) {
  const dt = Math.min(0.05, (ts - last) / 1000);
  last = ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

// ============================================================================
// STARTUP
// ============================================================================

updateInventory();
setScene('prologue');
requestAnimationFrame(loop);
