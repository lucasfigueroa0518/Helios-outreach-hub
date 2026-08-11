'use client';

import React from 'react';

type Variant = 'primary' | 'outline' | 'dark';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: React.ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-[#FF5E1A] text-white hover:bg-[#E54E0F] shadow-cta-glow active:scale-95 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
  outline:
    'bg-transparent text-[#FF5E1A] border border-[#FF5E1A] hover:bg-[#FF5E1A] hover:text-white active:scale-95 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
  dark:
    'bg-[#171717] text-white hover:bg-[#262626] active:scale-95 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
};

export default function Button({
  variant = 'primary',
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-pill px-6 py-3 text-sm font-medium tracking-wide font-body ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
