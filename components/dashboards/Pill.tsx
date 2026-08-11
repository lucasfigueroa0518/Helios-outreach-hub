import React from 'react';

interface PillProps {
  children: React.ReactNode;
  className?: string;
}

export default function Pill({ children, className = '' }: PillProps) {
  return (
    <span
      className={`inline-flex items-center rounded-pill bg-[#FF5E1A] px-3 py-1 text-[12px] font-bold uppercase tracking-[0.18em] text-white ${className}`}
    >
      {children}
    </span>
  );
}
