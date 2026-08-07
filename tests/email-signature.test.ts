import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendPlainTextSignature,
  buildOutreachEmailHtml,
  buildSignatureHtml,
  isSenderProfileSignatureReady,
  LUCAS_SIGNATURE_DEFAULTS,
  publicAppOrigin,
  resolveEmailSignature,
  SIGNATURE_HEADSHOT_CID,
  stripTrailingTextSignature,
} from '@/lib/drafting/email-signature';

test('resolveEmailSignature hardcodes Lucas identity and requires cid for headshot on send', () => {
  const sig = resolveEmailSignature({
    workEmail: 'lucas@heliosgroup.ai',
    displayName: 'Lucas',
    title: 'President',
  });
  assert.equal(sig.displayName, LUCAS_SIGNATURE_DEFAULTS.displayName);
  assert.equal(sig.title, 'President');
  assert.equal(sig.companyName, 'Helios Group');
  assert.equal(sig.headshotUrl, null);

  const withCid = resolveEmailSignature({
    workEmail: 'lucas@heliosgroup.ai',
    headshotUrlOverride: `cid:${SIGNATURE_HEADSHOT_CID}`,
  });
  assert.equal(withCid.headshotUrl, `cid:${SIGNATURE_HEADSHOT_CID}`);
});

test('resolveEmailSignature never emits remote headshot URLs unless allowRemoteHeadshot', () => {
  const prev = process.env.HELIOS_PUBLIC_URL;
  process.env.HELIOS_PUBLIC_URL = 'https://www.heliosgroup.tech';
  try {
    const profileId = '11111111-1111-1111-1111-111111111111';
    const sendSafe = resolveEmailSignature({
      workEmail: 'teammate@heliosgroup.ai',
      displayName: 'Alex Example',
      title: 'Associate',
      companyName: 'Helios Group',
      profileId,
      headshotStoragePath: 'sender-headshots/u/p.jpg',
    });
    assert.equal(sendSafe.headshotUrl, null);

    const preview = resolveEmailSignature({
      workEmail: 'teammate@heliosgroup.ai',
      displayName: 'Alex Example',
      title: 'Associate',
      companyName: 'Helios Group',
      profileId,
      headshotStoragePath: 'sender-headshots/u/p.jpg',
      allowRemoteHeadshot: true,
    });
    assert.equal(preview.headshotUrl, `https://www.heliosgroup.tech/api/public/sender-headshots/${profileId}`);
    assert.match(buildSignatureHtml(preview), /Alex Example/);
  } finally {
    if (prev === undefined) delete process.env.HELIOS_PUBLIC_URL;
    else process.env.HELIOS_PUBLIC_URL = prev;
  }
});

test('stripTrailingTextSignature removes mirrored name/title/company and sign-offs', () => {
  const body = 'Hello there.\n\nThanks,\nLucas Figueroa\nPresident\nHelios Group';
  const cleaned = stripTrailingTextSignature(body, {
    displayName: 'Lucas Figueroa',
    title: 'President',
    companyName: 'Helios Group',
  });
  assert.equal(cleaned, 'Hello there.');
});

test('stripTrailingTextSignature removes first-name and Title, Company lines', () => {
  const body = 'Would a brief reply work if this is relevant?\n\nLucas\nPresident, Helios';
  const cleaned = stripTrailingTextSignature(body, {
    displayName: 'Lucas Figueroa',
    title: 'President',
    companyName: 'Helios Group',
  });
  assert.equal(cleaned, 'Would a brief reply work if this is relevant?');
});

test('isSenderProfileSignatureReady requires headshot except for Lucas', () => {
  assert.equal(
    isSenderProfileSignatureReady({
      display_name: 'Alex',
      title: 'Associate',
      work_email: 'alex@heliosgroup.ai',
      headshot_storage_path: null,
    }),
    false,
  );
  assert.equal(
    isSenderProfileSignatureReady({
      display_name: 'Alex',
      title: 'Associate',
      work_email: 'alex@heliosgroup.ai',
      headshot_storage_path: 'sender-headshots/x.jpg',
    }),
    true,
  );
  assert.equal(
    isSenderProfileSignatureReady({
      display_name: 'Lucas Figueroa',
      title: 'President',
      work_email: 'lucas@heliosgroup.ai',
      headshot_storage_path: null,
    }),
    true,
  );
});

test('buildOutreachEmailHtml includes cid photo table signature', () => {
  const sig = resolveEmailSignature({
    workEmail: 'lucas@heliosgroup.ai',
    title: 'President',
    headshotUrlOverride: `cid:${SIGNATURE_HEADSHOT_CID}`,
  });
  const html = buildOutreachEmailHtml('Hi Sam,\n\nQuick note.', sig);
  assert.match(html, /<img /);
  assert.match(html, new RegExp(`cid:${SIGNATURE_HEADSHOT_CID}`));
  assert.match(html, /Lucas Figueroa/);
  assert.match(html, /President/);
  assert.match(html, /Helios Group/);
  const text = appendPlainTextSignature('Hi Sam,\n\nQuick note.', sig);
  assert.match(text, /Lucas Figueroa\nPresident\nHelios Group/);
});

test('publicAppOrigin ignores localhost AUTH_URL and defaults to production', () => {
  const prevPublic = process.env.HELIOS_PUBLIC_URL;
  const prevAuth = process.env.AUTH_URL;
  delete process.env.HELIOS_PUBLIC_URL;
  process.env.AUTH_URL = 'http://localhost:3000';
  try {
    assert.equal(publicAppOrigin(), 'https://www.heliosgroup.tech');
  } finally {
    if (prevPublic === undefined) delete process.env.HELIOS_PUBLIC_URL;
    else process.env.HELIOS_PUBLIC_URL = prevPublic;
    if (prevAuth === undefined) delete process.env.AUTH_URL;
    else process.env.AUTH_URL = prevAuth;
  }
});
