import React, { useState } from 'react';

interface ConfirmButtonProps {
  onConfirm: () => void;
  className?: string;
  children: React.ReactNode;
}

export function ConfirmButton({ onConfirm, className = 'btn btn-danger btn-sm', children }: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <button
      className={`${className}${confirming ? ' confirm-active' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (confirming) {
          setConfirming(false);
          onConfirm();
        } else {
          setConfirming(true);
        }
      }}
      onMouseLeave={() => setConfirming(false)}
    >
      {confirming ? 'Confirm' : children}
    </button>
  );
}
