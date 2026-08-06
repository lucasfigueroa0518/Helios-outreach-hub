'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

import type { SenderProfile } from '@/app/campaigns/[id]/draft/types';

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
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [workEmail, setWorkEmail] = useState(defaultWorkEmail);
  const [title, setTitle] = useState('');
  const [signatureMode, setSignatureMode] = useState<'name' | 'name_and_role'>('name_and_role');
  const [voiceNotes, setVoiceNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const response = await fetch('/api/sender-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: displayName.trim(),
        work_email: workEmail.trim(),
        title: title.trim(),
        signature_mode: signatureMode,
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
              These are sender facts the system is not allowed to guess. Confirm before drafting begins.
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
              <span className="field__label">Embark work email</span>
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
              <span className="field__label">Current title / role</span>
              <input
                className="field__input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
            </label>
            <fieldset className="field">
              <legend className="field__label">Email signature</legend>
              <div className="segmented drafting-signature-toggle">
                <button
                  type="button"
                  className={`segmented__item${signatureMode === 'name' ? ' segmented__item--active' : ''}`}
                  onClick={() => setSignatureMode('name')}
                >
                  Name only
                </button>
                <button
                  type="button"
                  className={`segmented__item${signatureMode === 'name_and_role' ? ' segmented__item--active' : ''}`}
                  onClick={() => setSignatureMode('name_and_role')}
                >
                  Name + role
                </button>
              </div>
            </fieldset>
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
            <button className="btn btn--primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save and continue'}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
