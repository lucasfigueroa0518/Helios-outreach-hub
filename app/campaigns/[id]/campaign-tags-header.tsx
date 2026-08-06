'use client';

import { useState } from 'react';
import { Tag } from 'lucide-react';
import { requestJson } from '@/lib/client-request';
import { TagBadge } from '@/app/components/tag-badge';
import { TagInputPopover } from '@/app/components/tag-input-popover';
import { TagWithColor } from '@/lib/campaigns';

export function CampaignTagsHeader({
  campaignId,
  initialTags = [],
  initialTagDetails = [],
}: {
  campaignId: string;
  initialTags?: string[];
  initialTagDetails?: TagWithColor[];
}) {
  const [tagDetails, setTagDetails] = useState<TagWithColor[]>(
    initialTagDetails.length
      ? initialTagDetails
      : initialTags.map((t) => ({ tag: t, color: null })),
  );
  const [editing, setEditing] = useState(false);

  async function addTag(tagName: string, colorId: string) {
    try {
      const data = await requestJson<{ tags: TagWithColor[] }>(`/api/campaigns/${campaignId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tagName, color: colorId }),
      });
      if (data.tags) {
        setTagDetails(data.tags);
      }
      setEditing(false);
    } catch {
      // Ignore
    }
  }

  async function removeTag(tag: string) {
    try {
      const data = await requestJson<{ tags: TagWithColor[] }>(`/api/campaigns/${campaignId}/tags?tag=${encodeURIComponent(tag)}`, {
        method: 'DELETE',
      });
      if (data.tags) {
        setTagDetails(data.tags);
      }
    } catch {
      // Ignore
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
      <Tag size={13} style={{ color: 'var(--color-primary)' }} />
      {tagDetails.map((t) => (
        <TagBadge
          key={t.tag}
          tag={t.tag}
          color={t.color}
          onRemove={() => void removeTag(t.tag)}
          size="md"
        />
      ))}

      {editing ? (
        <TagInputPopover
          onAddTag={addTag}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          style={{
            border: '1px dashed var(--color-border)',
            background: 'none',
            borderRadius: 'var(--radius-pill)',
            padding: '2px 8px',
            fontSize: '11px',
            fontWeight: '500',
            cursor: 'pointer',
            color: 'var(--color-text-subtle)',
          }}
        >
          + Add Tag
        </button>
      )}
    </div>
  );
}
