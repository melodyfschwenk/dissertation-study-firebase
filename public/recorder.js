// ===== RECORDER.JS – START (paste everything below) =====
import { CONFIG } from './config.js';

/**
 * Updates the "Image X of 2" UI + image src and resets the status line.
 * No changes needed here unless you rename CONFIG.IMAGE_1/IMAGE_2.
 */
export function updateRecordingImage(state) {
  const imageNum = state.recording.currentImage + 1;
  const numSpan = document.getElementById('image-number');
  const img = document.getElementById('current-image');
  if (numSpan) numSpan.textContent = imageNum;
  if (img) img.src = imageNum === 1 ? CONFIG.IMAGE_1 : CONFIG.IMAGE_2;

  const status = document.getElementById('recording-status');
  if (status) {
    status.textContent = 'Ready to upload';
    status.className = 'recording-status ready';
  }

  // If an old Uploadcare context exists, clear it (harmless if absent)
  const ctx = document.getElementById('ucctx');
  if (ctx && ctx.uploadCollection && typeof ctx.uploadCollection.clearAll === 'function') {
    ctx.uploadCollection.clearAll();
  }
}

/**
 * Uploader bridge:
 * - If index.html has attached a Firebase-based uploader to window.setupUploadcareUploader,
 *   we delegate to it.
 * - Otherwise this is a no-op so the app won’t crash.
 * You do NOT need to edit this.
 */
export function setupUploadcareUploader(state, sendToSheets, completeTask) {
  if (typeof window !== 'undefined'
      && typeof window.setupUploadcareUploader === 'function'
      && window.setupUploadcareUploader !== setupUploadcareUploader) {
    return window.setupUploadcareUploader(state, sendToSheets, completeTask);
  }
  console.warn('[recorder.js] No Firebase uploader found on window.setupUploadcareUploader; using no-op.');
}

/**
 * Hook up the “Unable to complete” skip button for the recording task.
 * No changes needed here.
 */
export function bindRecordingSkips(showSkipDialog) {
  const btn = document.getElementById('skip-recording-btn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      showSkipDialog('ID');
    });
  }
}

/**
 * Cleanup hook (kept for symmetry). Extend if you add recorder resources to release.
 */
export function cleanupRecording() {
  return Promise.resolve();
}

export default {
  updateRecordingImage,
  setupUploadcareUploader,
  bindRecordingSkips,
  cleanupRecording,
};
// ===== RECORDER.JS – END =====
// (the above is the entire content of recorder.js)