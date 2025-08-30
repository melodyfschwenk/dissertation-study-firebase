

// public/debug.js
(() => {
  // --- Tiny “video” generator for upload test (falls back if MediaRecorder unavailable) ---
  async function makeTinyTestVideo({ ms = 800, fps = 10 } = {}) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      const canCheck = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
      const mime = canCheck && MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9'
        : canCheck && MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8'
        : 'video/webm';
      const stream = canvas.captureStream ? canvas.captureStream(fps) : null;
      if (!stream) throw new Error('Canvas captureStream not supported; using byte fallback.');

      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 250000 });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

      let t = 0;
      const drawId = setInterval(() => {
        ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 64, 64);
        ctx.fillStyle = '#fff'; ctx.fillRect((t * 3) % 64, (t * 2) % 64, 16, 16);
        t++;
      }, Math.round(1000 / fps));

      rec.start(100);
      await new Promise(r => setTimeout(r, ms));
      rec.stop();
      await new Promise(r => rec.onstop = r);
      clearInterval(drawId);
      stream.getTracks().forEach(tr => tr.stop());

      return new Blob(chunks, { type: 'video/webm' });
    } catch {
      // Minimal 4-byte “webm-ish” blob — good enough to test Storage permissions
      const testData = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]);
      return new Blob([testData], { type: 'video/webm' });
    }
  }

  // --- Main debug routine ---
  async function debugFirebase() {
    console.log('🔧 Firebase debug starting…');

    // 0) Basic presence checks
    if (!window.firebase) {
      console.error('❌ window.firebase not found. Make sure compat SDK scripts are included before debug.js.');
      alert('Firebase SDK not loaded — check script tags.');
      return;
    }

    // Firestore (compat) and Storage (compat) handles
    const db = window.db || (firebase.firestore ? firebase.firestore() : null);
    const storage = window.storage || (firebase.storage ? firebase.storage() : null);

    if (!db) {
      console.error('❌ Firestore not available (window.db or firebase.firestore()).');
      alert('Firestore not available — check your Firebase initialization.');
      return;
    }
    if (!storage) {
      console.error('❌ Storage not available (window.storage or firebase.storage()).');
      alert('Firebase Storage not available — check your Firebase initialization.');
      return;
    }

    // 1) Firestore write/read test
    console.log('🗄️  Firestore: write/read test…');
    const runId = 'run_' + Date.now();
    const docRef = db.collection('debug_runs').doc(runId);
    try {
      await docRef.set({
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        userAgent: navigator.userAgent,
        page: location.href
      }, { merge: true });

      const snap = await docRef.get();
      if (!snap.exists) throw new Error('Wrote doc but could not read it back.');
      console.log('✅ Firestore OK:', { id: snap.id, data: snap.data() });
    } catch (err) {
      console.error('❌ Firestore test failed:', err);
      alert('Firestore test failed: ' + (err && err.message || err));
      return;
    }

    // 2) Storage upload test (with progress + download URL)
    console.log('📦 Storage: upload test…');
    try {
      const blob = await makeTinyTestVideo();
      const path = `debug/${runId}.webm`;
      const ref = storage.ref().child(path);

      const task = ref.put(blob, {
        contentType: blob.type || 'video/webm',
        customMetadata: { session_code: 'DEBUG', generated: new Date().toISOString() }
      });

      await new Promise((resolve, reject) => {
        task.on('state_changed',
          (snap) => {
            const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
            console.log(`   ↳ uploading… ${pct}%`);
          },
          reject,
          resolve
        );
      });

      const url = await ref.getDownloadURL();
      console.log('✅ Storage OK. File path:', path);
      console.log('   ↳ Download URL:', url);
      alert('Firebase Storage is working!\n' + url);
    } catch (err) {
      console.error('❌ Storage test failed:', err);
      alert('Storage test failed: ' + (err && err.message || err));
      return;
    }

    console.log('🎉 All Firebase checks passed.');
  }

  // Expose helpers for easy manual use
  window.debugFirebase = debugFirebase;
  window.makeTinyTestVideo = makeTinyTestVideo;
})();
