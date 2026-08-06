'use client';

import { useState, useRef, useEffect } from 'react';
import { Check, Plus, Palette } from 'lucide-react';
import { TAG_COLOR_PALETTE, TagColorOption } from '@/lib/tag-colors';

export function TagInputPopover({
  onAddTag,
  onCancel,
  placeholder = 'tag name',
}: {
  onAddTag: (tagName: string, colorId: string) => Promise<void> | void;
  onCancel?: () => void;
  placeholder?: string;
}) {
  const [tagName, setTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState<TagColorOption>(TAG_COLOR_PALETTE[0]);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [submitting, setSaving] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const clean = tagName.trim();
    if (!clean || submitting) return;
    setSaving(true);
    try {
      await onAddTag(clean, selectedColor.id);
      setTagName('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Floating Color Selector Pop-up */}
      {showColorPicker && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            zIndex: 100,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 10px',
            boxShadow: 'var(--shadow-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            minWidth: '180px',
            animation: 'drawer-fade 0.15s ease-out',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '10px',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              color: 'var(--color-text-subtle)',
              letterSpacing: '0.5px',
            }}
          >
            <span>Tag Color</span>
            <span style={{ color: selectedColor.text, fontWeight: 'bold' }}>
              {selectedColor.label}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(6, 1fr)',
              gap: '6px',
            }}
          >
            {TAG_COLOR_PALETTE.map((c) => {
              const isSelected = c.id === selectedColor.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  title={c.label}
                  onClick={() => {
                    setSelectedColor(c);
                    setShowColorPicker(false);
                  }}
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    backgroundColor: c.hex,
                    border: isSelected ? '2px solid var(--color-surface)' : '1px solid rgba(0,0,0,0.1)',
                    boxShadow: isSelected ? `0 0 0 2px ${c.hex}` : 'none',
                    cursor: 'pointer',
                    transition: 'transform 0.1s ease',
                    padding: 0,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Styled Tag Input Box */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-pill)',
          padding: '2px 4px 2px 6px',
          boxShadow: 'var(--shadow-sm)',
          height: '26px',
        }}
      >
        {/* Color Swatch Button */}
        <button
          type="button"
          onClick={() => setShowColorPicker(!showColorPicker)}
          title="Pick tag color"
          style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            backgroundColor: selectedColor.hex,
            border: 'none',
            cursor: 'pointer',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        >
          <Palette size={8} style={{ color: 'white', opacity: 0.8 }} />
        </button>

        {/* Text Input */}
        <input
          ref={inputRef}
          type="text"
          value={tagName}
          onChange={(e) => setTagName(e.target.value)}
          placeholder={placeholder}
          disabled={submitting}
          style={{
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: '11px',
            color: 'var(--color-text)',
            width: '75px',
            padding: 0,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (showColorPicker) setShowColorPicker(false);
              else onCancel?.();
            }
          }}
        />

        {/* Submit Action Button */}
        <button
          type="submit"
          disabled={submitting || !tagName.trim()}
          style={{
            border: 'none',
            background: 'var(--color-primary)',
            color: 'white',
            borderRadius: 'var(--radius-pill)',
            fontSize: '10px',
            fontWeight: 'bold',
            padding: '2px 8px',
            height: '20px',
            cursor: tagName.trim() && !submitting ? 'pointer' : 'default',
            opacity: tagName.trim() && !submitting ? 1 : 0.5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '2px',
          }}
        >
          {submitting ? '…' : 'Add'}
        </button>
      </form>
    </div>
  );
}
