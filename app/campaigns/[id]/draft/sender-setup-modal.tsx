'use client';

import { useMemo, useState } from 'react';
import { X } from 'lucide-react';

import type { SenderProfile } from '@/app/campaigns/[id]/draft/types';

const LUCAS_EMAIL = 'lucas@heliosgroup.ai';

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
  const lucasDefaults = defaultWorkEmail.trim().toLowerCase() === LUCAS_EMAIL;

  const [profileId, setProfileId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(
    lucasDefaults ? 'Lucas Figueroa' : defaultDisplayName,
  );
  const [workEmail, setWorkEmail] = useState(
    lucasDefaults ? LUCAS_EMAIL : defaultWorkEmail,
  );
  const [title, setTitle] = useState(lucasDefaults ? 'President' : '');
  const [companyName, setCompanyName] = useState('Helios Group');
  const [voiceNotes, setVoiceNotes] = useState('');
  const [headshotPath, setHeadshotPath] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(
    lucasDefaults ? '/signatures/lucas-figueroa.jpg' : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const lucasLocked = useMemo(
    () => workEmail.trim().toLowerCase() === LUCAS_EMAIL,
    [workEmail],
  );

  if (!open) return null;

  async function uploadHeadshot(file: File) {
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('file', file);
      if (profileId) body.set('profile_id', profileId);
      body.set('display_name', displayName.trim());
      body.set('work_email', workEmail.trim());
      body.set('title', title.trim() || 'Team member');
      body.set('company_name', companyName.trim() || 'Helios Group');

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
        display_name: displayName.trim(),
        work_email: workEmail.trim(),
        title: title.trim(),
        company_name: companyName.trim() || 'Helios Group',
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
              Name, role, company, and headshot power the email signature. Confirm before drafting begins.
            </div>
          </div>
          <button type="button" className="dialog__close" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="card__body">
          <form className="login-form" onSubmit={(event) => void save(event)}>
            <label className="field">
              <span className="field__label">Sender name</span>
              <input
                className="field__input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
                autoComplete="name"
              />
            </label>
            <label className="field">
              <span className="field__label">Work email</span>
              <input
                className="field__input"
                type="email"
                value={workEmail}
                onChange={(event) => setWorkEmail(event.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="field">
              <span className="field__label">Position / title</span>
              <input
                className="field__input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span className="field__label">Company name</span>
              <input
                className="field__input"
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                required
              />
            </label>

            <div className="field">
              <span className="field__label">Signature headshot (PNG or JPEG)</span>
              {lucasLocked ? (
                <p className="field__hint">
                  Your headshot is already configured for lucas@heliosgroup.ai.
                </p>
              ) : (
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
              )}
              <div className="sender-signature-preview" aria-label="Signature preview">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="" width={72} height={72} />
                ) : (
                  <div className="sender-signature-preview__placeholder" />
                )}
                <div className="sender-signature-preview__text">
                  <strong>{displayName.trim() || 'Full Name'}</strong>
                  <span>{title.trim() || 'Position'}</span>
                  <span>{companyName.trim() || 'Company Name'}</span>
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
            <button className="btn btn--primary" type="submit" disabled={saving || uploading}>
              {saving ? 'Saving…' : 'Save and continue'}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
