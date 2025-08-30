// === START ===
import { CONFIG } from './config.js';

// Minimal helper to get an extension from a MIME type or filename
function extFrom(file) {
  if (file && file.name && file.name.includes('.')) return file.name.split('.').pop().toLowerCase();
  if (!file || !file.type) return 'webm';
  if (file.type.includes('mp4')) return 'mp4';
  if (file.type.includes('quicktime')) return 'mov';
  if (file.type.includes('webm')) return 'webm';
  if (file.type.includes('x-m4a') || file.type === 'audio/mp4') return 'm4a';
  if (file.type.includes('wav')) return 'wav';
  return 'bin';
}

/**
 * Upload a recorded file to Firebase Storage under a session-scoped path.
 * Returns { success, path, url, size, contentType } on success.
 */
async function uploadToFirebaseStorage(file, sessionCode, imageNumber) {
  if (!window.storage) throw new Error('Firebase Storage not initialized');
  if (!sessionCode) throw new Error('Missing session code');

  const ext = extFrom(file);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeImage = typeof imageNumber === 'number' ? imageNumber : 1;
  const path = `sessions/${sessionCode}/image${safeImage}_${ts}.${ext}`;

  const ref = window.storage.ref(path);
  const snap = await ref.put(file, {
    contentType: file.type || 'application/octet-stream',
    customMetadata: { sessionCode, imageNumber: String(safeImage) }
  });
  const url = await snap.ref.getDownloadURL();
  return { success: true, path, url, size: snap.totalBytes, contentType: file.type || '' };
}

// expose for callers that expect it on window
window.uploadToFirebaseStorage = uploadToFirebaseStorage;

export function updateUploadProgress(percent, message) {
  const progressDiv = document.getElementById('upload-progress');
  const progressFill = document.getElementById('upload-progress-fill');
  const status = document.getElementById('upload-status');
  if (progressDiv) progressDiv.style.display = 'block';
  if (progressFill) progressFill.style.width = `${percent}%`;
  if (status) status.textContent = `${percent}%`;
  const progressText = progressDiv ? progressDiv.querySelector('div[style*="font-weight: bold"]') : null;
  if (progressText && message) progressText.textContent = message;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function getExtensionFromMime(mime) {
  if (!mime) return 'bin';
  mime = mime.toLowerCase();
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  return 'bin';
}
// END ===
