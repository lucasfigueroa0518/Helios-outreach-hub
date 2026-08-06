/**
 * Tag Color Palette & Styling Utility.
 * Provides curated distinct tag colors and deterministic color hashing for custom tags.
 */

export type TagColorOption = {
  id: string;
  label: string;
  hex: string;       // Primary swatch dot color
  bg: string;        // Soft badge background tint
  text: string;      // Badge text color
  border: string;    // Badge border tint
};

export const TAG_COLOR_PALETTE: TagColorOption[] = [
  { id: 'blue', label: 'Electric Blue', hex: '#027FF1', bg: 'rgba(2, 127, 241, 0.12)', text: '#0267c8', border: 'rgba(2, 127, 241, 0.3)' },
  { id: 'green', label: 'Spring Green', hex: '#00B74F', bg: 'rgba(0, 183, 79, 0.12)', text: '#008a2e', border: 'rgba(0, 183, 79, 0.3)' },
  { id: 'purple', label: 'Royal Violet', hex: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)', text: '#6d28d9', border: 'rgba(139, 92, 246, 0.3)' },
  { id: 'orange', label: 'Fire Orange', hex: '#FF8200', bg: 'rgba(255, 130, 0, 0.12)', text: '#d96800', border: 'rgba(255, 130, 0, 0.3)' },
  { id: 'rose', label: 'Cherry Rose', hex: '#F9423A', bg: 'rgba(249, 66, 58, 0.12)', text: '#dc2626', border: 'rgba(249, 66, 58, 0.3)' },
  { id: 'pink', label: 'Magenta Pink', hex: '#ec4899', bg: 'rgba(236, 72, 153, 0.12)', text: '#be185d', border: 'rgba(236, 72, 153, 0.3)' },
  { id: 'teal', label: 'Ocean Teal', hex: '#0d9488', bg: 'rgba(13, 148, 136, 0.12)', text: '#0f766e', border: 'rgba(13, 148, 136, 0.3)' },
  { id: 'indigo', label: 'Deep Indigo', hex: '#6366f1', bg: 'rgba(99, 102, 241, 0.12)', text: '#4338ca', border: 'rgba(99, 102, 241, 0.3)' },
  { id: 'amber', label: 'Amber Gold', hex: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', text: '#b45309', border: 'rgba(245, 158, 11, 0.3)' },
  { id: 'cyan', label: 'Sky Cyan', hex: '#06b6d4', bg: 'rgba(6, 182, 212, 0.12)', text: '#0e7490', border: 'rgba(6, 182, 212, 0.3)' },
  { id: 'emerald', label: 'Deep Emerald', hex: '#059669', bg: 'rgba(5, 150, 105, 0.12)', text: '#047857', border: 'rgba(5, 150, 105, 0.3)' },
  { id: 'slate', label: 'Slate Gray', hex: '#64748b', bg: 'rgba(100, 116, 139, 0.12)', text: '#334155', border: 'rgba(100, 116, 139, 0.3)' },
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getTagColorStyle(tagName: string, customColor?: string | null): TagColorOption {
  if (customColor) {
    const matched = TAG_COLOR_PALETTE.find((c) => c.id === customColor || c.hex.toLowerCase() === customColor.toLowerCase());
    if (matched) return matched;
    // If it's a hex code, compute custom style
    if (customColor.startsWith('#')) {
      return {
        id: 'custom',
        label: 'Custom',
        hex: customColor,
        bg: `${customColor}1e`,
        text: customColor,
        border: `${customColor}4d`,
      };
    }
  }

  // Deterministic fallback based on tag string
  const index = hashString(tagName.toLowerCase()) % TAG_COLOR_PALETTE.length;
  return TAG_COLOR_PALETTE[index];
}
