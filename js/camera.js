// In-app camera: a live preview and a shutter, so taking a photo never leaves the page.
// Handing over to the phone's camera app sends the browser to the background, where Android can
// stop it for memory ("can't continue, memory is low") and the photo is lost. Resolves with a
// JPEG of the frame, or null if closed; throws if the camera can't be opened.

export const hasCamera = () => !!navigator.mediaDevices?.getUserMedia && isSecureContext;

export async function takePhoto(title = '') {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
  });
  const ov = document.createElement('div');
  ov.className = 'cam';
  ov.innerHTML = `
    <div class="cam-bar"><button data-a="close">✕ Close</button><span class="cam-title"></span></div>
    <video autoplay playsinline muted></video>
    <div class="cam-shoot"><button data-a="shoot" aria-label="Take photo"></button></div>`;
  ov.querySelector('.cam-title').textContent = title;
  const video = ov.querySelector('video');
  video.srcObject = stream;
  document.body.append(ov);
  document.body.classList.add('noscroll');

  return new Promise(resolve => {
    const done = blob => {
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
      ov.remove();
      document.body.classList.remove('noscroll');
      resolve(blob);
    };
    ov.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') done(null);
      if (a !== 'shoot' || !video.videoWidth) return;
      e.target.disabled = true;
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
      c.width = c.height = 0;
      done(blob);
    });
  });
}
