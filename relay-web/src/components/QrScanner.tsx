"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Camera QR scanner (rear camera when there is one). Calls onResult once with the first code it reads.
 * Frames are decoded on this device; nothing is uploaded.
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    navigator.mediaDevices
      // Ask for HD: a device code is a dense QR (about 81×81 squares) that needs 3–4 camera pixels per square, which at
      // the browser's default 640×480 means holding the phone too close to focus.
      ?.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(async (s) => {
        stream = s;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        await video.play().catch(() => {});
        timer = setInterval(() => {
          if (done.current || !ctx || video.readyState < 2) return;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code?.data) {
            done.current = true;
            onResultRef.current(code.data);
          }
        }, 250);
      })
      .catch(() => setError("Couldn't open the camera. Allow camera access, or paste the code instead."));
    if (!navigator.mediaDevices) setError("This browser can't use the camera here. Paste the code instead.");

    return () => {
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex flex-col gap-2 items-center">
      {error ? (
        <p className="text-sm text-red-500 text-center">{error}</p>
      ) : (
        <video ref={videoRef} playsInline muted className="w-64 h-64 object-cover rounded bg-black" />
      )}
      <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border border-[var(--border)] text-sm">
        Cancel
      </button>
    </div>
  );
}
