import {
  SENDER_IDENTITY_LABELS,
  type SenderIdentitySlug,
} from '@/lib/agentmail-inboxes';

export function CampaignTitle({
  name,
  senderIdentitySlug,
}: {
  name: string;
  senderIdentitySlug?: SenderIdentitySlug | null;
}) {
  const sender = senderIdentitySlug ? SENDER_IDENTITY_LABELS[senderIdentitySlug] : null;
  return (
    <div className="card__title">
      {name}
      {sender ? <span className="card__title-meta">{sender}</span> : null}
    </div>
  );
}
