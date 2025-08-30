// ===== TASKS.JS — START (paste everything below) =====

/* ===========================================
   EDIT ZONE #1 — TASK DEFINITIONS
   -------------------------------------------
   You may:
   - Change names, descriptions, URLs, estMinutes, requirements
   - Add or remove entire tasks (keep the key short like 'RC', 'MRT', etc.)
   - type must be one of: 'embed' | 'external' | 'recording'
   - For 'embed' tasks: use embedUrl (NOT url)
   - For 'external' tasks: use url (NOT embedUrl)
   - For 'recording' tasks: no url/embedUrl needed
   - 'skilled: true' = counts as a skilled task in analytics (optional)
   =========================================== */
export const TASKS = {
  'RC':   { name:'Reading Comprehension Task', description:'Read passages and answer questions', type:'embed',   embedUrl:'https://melodyfschwenk.github.io/readingcomp/',              canSkip:true, estMinutes:15, requirements:'None',                                     skilled:true },
  'MRT':  { name:'Mental Rotation Task',       description:'Decide if two images are the same or not', type:'embed',   embedUrl:'https://melodyfschwenk.github.io/mrt/',                  canSkip:true, estMinutes:6,  requirements:'Keyboard recommended',           skilled:true },
  'ASLCT':{ name:'ASL Comprehension Test',     description:'For ASL users only',                              url:'https://vl2portal.gallaudet.edu/assessment/', type:'external', canSkip:true, estMinutes:15, requirements:'ASL users; stable connection', skilled:true },
  'VCN':  { name:'Virtual Campus Navigation',  description:'Virtual SILC Test of Navigation (SILCton)',       url:'http://www.virtualsilcton.com/study/753798747', type:'external', canSkip:true, estMinutes:20, requirements:'Desktop/laptop; keyboard (WASD) & mouse', skilled:true },
  'SN':   { name:'Spatial Navigation',         description:'Choose the first step from the player to the stop sign (embedded below)', type:'embed',   embedUrl:'https://melodyfschwenk.github.io/spatial-navigation-web/', canSkip:true, estMinutes:8,  requirements:'Arrow keys',                     skilled:true },
  'ID':   { name:'Image Description',          description:'Record two short videos describing images (or upload if recording is unavailable).', type:'recording', canSkip:true, estMinutes:2, requirements:'Camera & microphone or video upload' },
  'DEMO': { name:'Demographics Survey',        description:'Background information & payment', url:'https://gallaudet.iad1.qualtrics.com/jfe/form/SV_8GJcoF3hkHoP8BU', type:'external', estMinutes:6, requirements:'None' }
};
/* ===== END EDIT ZONE #1 ===== */


/* ===========================================
   DO NOT EDIT — helper to get a friendly task name
   =========================================== */
export function getStandardTaskName(taskCode) {
  const mapping = {
    'RC': 'Reading Comprehension Task',
    'MRT': 'Mental Rotation Task',
    'ASLCT': 'ASL Comprehension Test',
    'VCN': 'Virtual Campus Navigation',
    'SN': 'Spatial Navigation',
    'ID': 'Image Description',
    'DEMO': 'Demographics Survey'
  };
  return mapping[taskCode] || (TASKS[taskCode] ? TASKS[taskCode].name : undefined) || taskCode;
}


/* ===========================================
   EDIT ZONE #2 — WHICH TASKS APPEAR ON EACH DEVICE
   -------------------------------------------
   If you ADD/REMOVE a task above, update these arrays.
   - Always keep 'DEMO' OUT of these lists; it gets appended last automatically.
   - Order affects the randomized base order (we shuffle these later).
   =========================================== */
export const DESKTOP_TASKS = ['RC', 'MRT', 'ASLCT', 'VCN', 'SN', 'ID'];
export const MOBILE_TASKS  = ['RC', 'MRT', 'ASLCT',       'SN', 'ID'];
/* ===== END EDIT ZONE #2 ===== */


/* ===========================================
   DO NOT EDIT — shuffling & device helpers
   =========================================== */
export function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function shuffleWithSeed(array, seed) {
  const rng = mulberry32(seed);
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function ensureDemographicsLast(sequence) {
  const filtered = (sequence || []).filter(code => code !== 'DEMO');
  filtered.push('DEMO');
  return filtered;
}

export function isMobileDevice() {
  const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || (navigator.msMaxTouchPoints > 0);
  const mobileUA = /Android|webOS|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent);
  const isSmallScreen = window.innerWidth <= 1024;
  return hasTouch && (mobileUA || isSmallScreen);
}

// ===== TASKS.JS — END =====
