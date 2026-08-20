'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import type { SenderProfile } from '@/app/campaigns/[id]/draft/types';
import {
  inferIdentitySlug,
  SENDER_IDENTITY_DEFAULTS,
  type SenderIdentitySlug,
} from '@/lib/agentmail-inboxes';

const PRIMARY_INBOX: Record<SenderIdentitySlug, string> = {
  lucas: 'lucas@heliosgroup.email',
  tommy: 'thomas@heliosgroup.email',
};

export function SenderSetupModal({
  defaultDisplayName,
  defaultWorkEmail,
  open,
  onClose,
  onSaved,
}: {
  defaultDisplayName: string;
  defaultWorkEmail: string;
  open: boolean;
  onClose: () => void;
  onSaved: (profile: SenderProfile) => void;
}) {
  const inferred = inferIdentitySlug({
    workEmail: defaultWorkEmail,
    displayName: defaultDisplayName,
  });

  const [profileId, setProfileId] = useState<string | null>(null);
  const [identitySlug, setIdentitySlug] = useState<SenderIdentitySlug>(inferred);
  const [voiceNotes, setVoiceNotes] = useState('');
  const [headshotPath, setHeadshotPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    SENDER_IDENTITY_DEFAULTS[inferred].headshotPublicPath,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const defaults = SENDER_IDENTITY_DEFAULTS[identitySlug];

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/sender-profiles');
        const data = await response.json();
        if (!response.ok || cancelled) return;
        const profile = (data.profiles as SenderProfile[] | undefined)?.[0];
        if (!profile) return;
        const slug = inferIdentitySlug({
          workEmail: profile.work_email,
          displayName: profile.display_name,
        });
        setProfileId(profile.id);
        setIdentitySlug(slug);
        setVoiceNotes(profile.voice_notes ?? '');
        setHeadshotPath(profile.headshot_storage_path);
        setPreviewUrl(
          SENDER_IDENTITY_DEFAULTS[slug].headshotPublicPath
          || (profile.headshot_storage_path
            ? `/api/public/sender-headshots/${profile.id}?t=${Date.now()}`
            : null),
        );
      } catch {
        // Keep defaults if the profile list fails to load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function selectIdentity(slug: SenderIdentitySlug) {
    setIdentitySlug(slug);
    setPreviewUrl(SENDER_IDENTITY_DEFAULTS[slug].headshotPublicPath);
    setError(null);
  }

  if (!open) return null;

  async function uploadHeadshot(file: File) {
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('file', file);
      if (profileId) body.set('profile_id', profileId);
      body.set('display_name', defaults.displayName);
      body.set('work_email', PRIMARY_INBOX[identitySlug]);
      body.set('title', defaults.title);
      body.set('company_name', defaults.companyName);

      const response = await fetch('/api/sender-profiles/headshot', {
        method: 'POST',
        body,
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? 'Could not upload headshot');
        return;
      }
      const profile = data.profile as SenderProfile;
      setProfileId(profile.id);
      setHeadshotPath(profile.headshot_storage_path);
      setPreviewUrl(`/api/public/sender-headshots/${profile.id}?t=${Date.now()}`);
    } catch {
      setError('Could not upload headshot');
    } finally {
      setUploading(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const response = await fetch('/api/sender-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: profileId ?? undefined,
        display_name: defaults.displayName,
        work_email: PRIMARY_INBOX[identitySlug],
        title: defaults.title,
        company_name: defaults.companyName,
        headshot_storage_path: headshotPath,
        signature_mode: 'name_and_role',
        voice_notes: voiceNotes.trim() || null,
        is_default: true,
      }),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      setError(data.error ?? 'Could not save sender profile');
      return;
    }
    onSaved(data.profile);
  }

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={() => !saving && onClose()}>
      <section
        className="card dialog drafting-sender-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sender-setup-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="card__header">
          <div>
            <div className="card__title" id="sender-setup-title">Sender setup</div>
            <div className="card__subtitle">
              Pick Lucas or Tommy. The specific From inbox is assigned when you queue — not here.
            </div>
          </div>
          <button type="button" className="dialog__close" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="card__body">
          <form className="login-form" onSubmit={(event) => void save(event)}>
            <div className="field">
              <span className="field__label">Send as</span>
              <div className="segmented" role="tablist">
                {(['lucas', 'tommy'] as const).map((slug) => (
                  <button
                    key={slug}
                    type="button"
                    className={identitySlug === slug ? 'segmented__item segmented__item--active' : 'segmented__item'}
                    onClick={() => selectIdentity(slug)}
                  >
                    {SENDER_IDENTITY_DEFAULTS[slug].displayName}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field__label">Signature</span>
              <p className="field__hint">
                All {identitySlug === 'lucas' ? 'four Lucas' : 'three Tommy'} inboxes share this signature.
                Headshot is optional — upload only if you want to replace the default.
              </p>
              <input
                className="field__input"
                type="file"
                accept="image/png,image/jpeg"
                disabled={uploading || saving}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadHeadshot(file);
                }}
              />
              <div className="sender-signature-preview" aria-label="Signature preview">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="" width={72} height={72} />
                ) : (
                  <div className="sender-signature-preview__placeholder" />
                )}
                <div className="sender-signature-preview__text">
                  <strong>{defaults.displayName}</strong>
                  <span>{defaults.title}</span>
                  <span>{defaults.companyName}</span>
                </div>
              </div>
              {uploading ? <p className="field__hint">Uploading headshot…</p> : null}
            </div>

            <label className="field">
              <span className="field__label">Voice / professional context (optional)</span>
              <textarea
                className="field__input drafting-sender-modal__voice"
                value={voiceNotes}
                onChange={(event) => setVoiceNotes(event.target.value)}
                rows={3}
                placeholder="How you usually sound in outreach — tone, background, or phrasing preferences."
              />
            </label>
            {error ? <p className="field__error" role="alert">{error}</p> : null}
            <button
              className="btn btn--primary"
              type="submit"
              disabled={saving || uploading}
            >
              {saving ? 'Saving…' : 'Save and continue'}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
