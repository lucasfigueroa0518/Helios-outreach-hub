import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendPlainTextSignature,
  buildOutreachEmailHtml,
  buildSignatureHtml,
  LUCAS_SIGNATURE_DEFAULTS,
  resolveEmailSignature,
  stripTrailingTextSignature,
} from '@/lib/drafting/email-signature';

test('resolveEmailSignature hardcodes Lucas headshot and identity', () => {
  const prev = process.env.HELIOS_PUBLIC_URL;
  process.env.HELIOS_PUBLIC_URL = 'https://www.heliosgroup.tech';
  try {
    const sig = resolveEmailSignature({
      workEmail: 'lucas@heliosgroup.ai',
      displayName: 'Lucas',
      title: 'President',
    });
    assert.equal(sig.displayName, LUCAS_SIGNATURE_DEFAULTS.displayName);
    assert.equal(sig.title, 'President');
    assert.equal(sig.companyName, 'Helios Group');
    assert.equal(
      sig.headshotUrl,
      `https://www.heliosgroup.tech${LUCAS_SIGNATURE_DEFAULTS.headshotPublicPath}`,
    );
  } finally {
    if (prev === undefined) delete process.env.HELIOS_PUBLIC_URL;
    else process.env.HELIOS_PUBLIC_URL = prev;
  }
});

test('resolveEmailSignature uses public headshot route for other profiles', () => {
  const prev = process.env.HELIOS_PUBLIC_URL;
  process.env.HELIOS_PUBLIC_URL = 'https://www.heliosgroup.tech';
  try {
    const profileId = '11111111-1111-1111-1111-111111111111';
    const sig = resolveEmailSignature({
      workEmail: 'teammate@heliosgroup.ai',
      displayName: 'Alex Example',
      title: 'Associate',
      companyName: 'Helios Group',
      profileId,
      headshotStoragePath: 'sender-headshots/u/p.jpg',
    });
    assert.equal(sig.headshotUrl, `https://www.heliosgroup.tech/api/public/sender-headshots/${profileId}`);
    assert.match(buildSignatureHtml(sig), /Alex Example/);
    assert.match(buildSignatureHtml(sig), /Associate/);
    assert.match(buildSignatureHtml(sig), /Helios Group/);
  } finally {
    if (prev === undefined) delete process.env.HELIOS_PUBLIC_URL;
    else process.env.HELIOS_PUBLIC_URL = prev;
  }
});

test('stripTrailingTextSignature removes mirrored name/title/company lines', () => {
  const body = 'Hello there.\n\nThanks,\nLucas Figueroa\nPresident\nHelios Group';
  const cleaned = stripTrailingTextSignature(body, {
    displayName: 'Lucas Figueroa',
    title: 'President',
    companyName: 'Helios Group',
  });
  assert.equal(cleaned, 'Hello there.\n\nThanks,');
});

test('buildOutreachEmailHtml includes photo table signature', () => {
  const prev = process.env.HELIOS_PUBLIC_URL;
  process.env.HELIOS_PUBLIC_URL = 'https://www.heliosgroup.tech';
  try {
    const sig = resolveEmailSignature({ workEmail: 'lucas@heliosgroup.ai', title: 'President' });
    const html = buildOutreachEmailHtml('Hi Sam,\n\nQuick note.', sig);
    assert.match(html, /<img /);
    assert.match(html, /Lucas Figueroa/);
    assert.match(html, /President/);
    assert.match(html, /Helios Group/);
    const text = appendPlainTextSignature('Hi Sam,\n\nQuick note.', sig);
    assert.match(text, /Lucas Figueroa\nPresident\nHelios Group/);
  } finally {
    if (prev === undefined) delete process.env.HELIOS_PUBLIC_URL;
    else process.env.HELIOS_PUBLIC_URL = prev;
  }
});