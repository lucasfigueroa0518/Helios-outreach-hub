import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  large?: boolean;
}

export default function Card({ children, className = '', large = false }: CardProps) {
  const radius = large ? 'rounded-card-lg' : 'rounded-card-md';
  return (
    <div
      className={`bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.18)] hover:-translate-y-1 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${radius} ${className}`}
    >
      {children}
    </div>
  );
}
