'use client';

import { getTagColorStyle } from '@/lib/tag-colors';

export function TagBadge({
  tag,
  color,
  onRemove,
  onClick,
  isSelected,
  size = 'md',
}: {
  tag: string;
  color?: string | null;
  onRemove?: () => void;
  onClick?: () => void;
  isSelected?: boolean;
  size?: 'sm' | 'md';
}) {
  const style = getTagColorStyle(tag, color);

  const isSmall = size === 'sm';

  return (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        backgroundColor: style.bg,
        color: style.text,
        border: isSelected ? `1.5px solid ${style.hex}` : `1px solid ${style.border}`,
        borderRadius: 'var(--radius-pill)',
        padding: isSmall ? '1px 6px' : '2px 8px',
        fontSize: isSmall ? '10px' : '11px',
        fontWeight: isSelected ? 'bold' : '600',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: isSelected ? `0 0 0 1px ${style.hex}` : 'none',
        transition: 'all 0.15s ease',
        userSelect: 'none',
        lineHeight: 1.2,
      }}
    >
      <span
        style={{
          width: isSmall ? '5px' : '6px',
          height: isSmall ? '5px' : '6px',
          borderRadius: '50%',
          backgroundColor: style.hex,
          flexShrink: 0,
        }}
      />
      <span>#{tag}</span>

      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            border: 'none',
            background: 'none',
            color: style.text,
            opacity: 0.7,
            cursor: 'pointer',
            padding: '0 1px',
            fontSize: isSmall ? '11px' : '12px',
            fontWeight: 'bold',
            lineHeight: 1,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title={`Remove #${tag}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
