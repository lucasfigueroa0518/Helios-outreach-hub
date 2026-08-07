'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Palette } from 'lucide-react';

import type { TagWithColor } from '@/lib/campaigns';
import { TAG_COLOR_PALETTE, type TagColorOption, getTagColorStyle } from '@/lib/tag-colors';

const MAX_SUGGESTIONS = 8;

export function TagInputPopover({
  onAddTag,
  onCancel,
  excludeTags = [],
  placeholder = 'tag name',
}: {
  onAddTag: (tagName: string, colorId: string) => Promise<void> | void;
  onCancel?: () => void;
  /** Tags already on this campaign — hidden from the picker. */
  excludeTags?: string[];
  placeholder?: string;
}) {
  const [tagName, setTagName] = useState('');
  const [selectedColor, setSelectedColor] = useState<TagColorOption>(TAG_COLOR_PALETTE[0]);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [submitting, setSaving] = useState(false);
  const [existingTags, setExistingTags] = useState<TagWithColor[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const excludeSet = useMemo(
    () => new Set(excludeTags.map((tag) => tag.trim().toLowerCase())),
    [excludeTags],
  );

  const suggestions = useMemo(() => {
    const query = tagName.trim().toLowerCase();
    const available = existingTags.filter((entry) => !excludeSet.has(entry.tag.toLowerCase()));
    const filtered = query
      ? available.filter((entry) => entry.tag.toLowerCase().includes(query))
      : available;
    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [existingTags, excludeSet, tagName]);

  const exactMatch = useMemo(() => {
    const query = tagName.trim().toLowerCase();
    if (!query) return null;
    return suggestions.find((entry) => entry.tag.toLowerCase() === query) ?? null;
  }, [suggestions, tagName]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/tags');
        if (!response.ok) return;
        const data = await response.json() as { tags?: TagWithColor[] };
        if (!cancelled && Array.isArray(data.tags)) {
          setExistingTags(data.tags);
        }
      } catch {
        // Suggestions are optional — free-text add still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setHighlightIndex(0);
  }, [tagName, suggestions.length]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function submitTag(name: string, colorId: string) {
    const clean = name.trim();
    if (!clean || submitting) return;
    setSaving(true);
    try {
      await onAddTag(clean, colorId);
      setTagName('');
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (exactMatch) {
      const colorId = exactMatch.color
        ?? getTagColorStyle(exactMatch.tag, exactMatch.color).id;
      await submitTag(exactMatch.tag, colorId);
      return;
    }
    if (
      showSuggestions
      && suggestions.length > 0
      && highlightIndex >= 0
      && highlightIndex < suggestions.length
      && tagName.trim()
    ) {
      const pick = suggestions[highlightIndex]!;
      // Only auto-pick highlighted suggestion when it matches the typed prefix.
      if (pick.tag.toLowerCase().startsWith(tagName.trim().toLowerCase())) {
        const colorId = pick.color ?? getTagColorStyle(pick.tag, pick.color).id;
        await submitTag(pick.tag, colorId);
        return;
      }
    }
    await submitTag(tagName, selectedColor.id);
  }

  async function pickSuggestion(entry: TagWithColor) {
    const colorId = entry.color ?? getTagColorStyle(entry.tag, entry.color).id;
    // Sync swatch so the form reflects the picked tag color.
    const matched = TAG_COLOR_PALETTE.find((c) => c.id === colorId);
    if (matched) setSelectedColor(matched);
    await submitTag(entry.tag, colorId);
  }

  const listOpen = showSuggestions && !showColorPicker && suggestions.length > 0;

  return (
    <div
      ref={containerRef}
      className="tag-input"
      onClick={(e) => e.stopPropagation()}
    >
      {showColorPicker ? (
        <div className="tag-input__color-menu" role="dialog" aria-label="Tag color">
          <div className="tag-input__color-menu-head">
            <span>Tag Color</span>
            <span style={{ color: selectedColor.text }}>{selectedColor.label}</span>
          </div>
          <div className="tag-input__color-grid">
            {TAG_COLOR_PALETTE.map((c) => {
              const isSelected = c.id === selectedColor.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  title={c.label}
                  className={`tag-input__swatch${isSelected ? ' tag-input__swatch--active' : ''}`}
                  style={{
                    backgroundColor: c.hex,
                    boxShadow: isSelected ? `0 0 0 2px ${c.hex}` : undefined,
                  }}
                  onClick={() => {
                    setSelectedColor(c);
                    setShowColorPicker(false);
                  }}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {listOpen ? (
        <ul
          id="tag-input-suggestions"
          className="tag-input__suggestions"
          role="listbox"
          aria-label="Existing tags"
        >
          {suggestions.map((entry, index) => {
            const style = getTagColorStyle(entry.tag, entry.color);
            const active = index === highlightIndex;
            return (
              <li key={entry.tag} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={`tag-input__suggestion${active ? ' tag-input__suggestion--active' : ''}`}
                  onMouseEnter={() => setHighlightIndex(index)}
                  onClick={() => void pickSuggestion(entry)}
                >
                  <span
                    className="tag-input__suggestion-dot"
                    style={{ backgroundColor: style.hex }}
                    aria-hidden="true"
                  />
                  <span className="tag-input__suggestion-label">{entry.tag}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <form className="tag-input__form" onSubmit={(e) => void handleSubmit(e)}>
        <button
          type="button"
          className="tag-input__color-btn"
          title="Pick tag color"
          style={{ backgroundColor: selectedColor.hex }}
          onClick={() => {
            setShowColorPicker((open) => !open);
            setShowSuggestions(false);
          }}
        >
          <Palette size={8} />
        </button>

        <input
          ref={inputRef}
          type="text"
          className="tag-input__field"
          value={tagName}
          placeholder={placeholder}
          disabled={submitting}
          aria-autocomplete="list"
          aria-expanded={listOpen}
          aria-controls={listOpen ? 'tag-input-suggestions' : undefined}
          onChange={(e) => {
            setTagName(e.target.value);
            setShowSuggestions(true);
            setShowColorPicker(false);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              if (showColorPicker) {
                setShowColorPicker(false);
                return;
              }
              if (listOpen) {
                setShowSuggestions(false);
                return;
              }
              onCancel?.();
              return;
            }
            if (!listOpen) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlightIndex((index) => (index + 1) % suggestions.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlightIndex((index) => (
                index <= 0 ? suggestions.length - 1 : index - 1
              ));
            } else if (e.key === 'Enter' && suggestions.length > 0 && !tagName.trim()) {
              // Empty query + Enter: pick highlighted existing tag.
              e.preventDefault();
              void pickSuggestion(suggestions[highlightIndex]!);
            }
          }}
        />

        <button
          type="submit"
          className="tag-input__add"
          disabled={submitting || !tagName.trim()}
        >
          {submitting ? '…' : 'Add'}
        </button>
      </form>
    </div>
  );
}
