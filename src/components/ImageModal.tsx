"use client";

interface ImageModalProps {
  src: string | null;
  onClose: () => void;
}

export default function ImageModal({ src, onClose }: ImageModalProps) {
  if (!src) return null;
  return (
    <div className="image-modal visible">
      <div className="image-modal-backdrop" onClick={onClose} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="image-modal-img" src={src} alt="Full size" />
    </div>
  );
}
