import React from 'react';

type EyebrowColor = 'green' | 'orange' | 'ink';

interface EyebrowProps {
  color?: EyebrowColor;
  children: React.ReactNode;
  className?: string;
}

const colorClasses: Record<EyebrowColor, string> = {
  green: 'text-[#138510]',
  orange: 'text-[#FF5E1A]',
  ink: 'text-[#171717]',
};

export default function Eyebrow({
  color = 'green',
  children,
  className = '',
}: EyebrowProps) {
  return (
    <p
      className={`font-body text-[13px] font-bold uppercase tracking-[0.18em] ${colorClasses[color]} ${className}`}
    >
      {children}
    </p>
  );
}
