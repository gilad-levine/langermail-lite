'use strict';

/*
 * LangerMail Lite — HubSpot Custom Code Action (Design A)
 * -------------------------------------------------------
 * Paste this whole file into an Operations Hub "Custom code" workflow action.
 * It reads a "Transactional Email" custom object, resolves its HTML (from a
 * long-text property OR an attached file), strips the footer, substitutes
 * {{merge_tags}} from the enrolled contact, and sends via AWS SES — all with
 * zero external dependencies (Node built-in `crypto` + global `fetch`).
 *
 * ── Secrets to configure on the code action ────────────────────────────────
 *   HUBSPOT_TOKEN                    private-app access token (scopes below)
 *   AWS_ACCESS_KEY_ID                SES sender IAM key id
 *   AWS_SECRET_ACCESS_KEY            SES sender IAM secret
 *   AWS_REGION                       SES region, e.g. us-east-1  (must match
 *                                    where mail.langerlabs.com is verified)
 *   TRANSACTIONAL_EMAIL_OBJECT_TYPE  custom object type — fully-qualified name
 *                                    (p12345_transactional_email) or id (2-1234567)
 *   SES_CONFIGURATION_SET            (optional) for open/click/bounce tracking
 *
 * Private-app scopes: crm.objects.custom.read, crm.objects.contacts.read, files
 *
 * ── Input fields to map in the workflow ────────────────────────────────────
 *   transactional_email_id   → the Transactional Email record id (required)
 *   email                    → contact.email (required; the recipient)
 *   <anything else>          → becomes a merge token, e.g. map contact.firstname
 *                              so the HTML can use {{firstname}}
 *
 * ── Output fields ──────────────────────────────────────────────────────────
 *   status      "sent" | "error"
 *   messageId   SES message id on success
 *   error       message on failure
 */

const crypto = require('crypto');

// ── Property names on the Transactional Email object (override here if yours differ) ──
const PROPS = {
  subject: 'subject',
  fromName: 'from_name',
  fromEmail: 'from_email',
  replyTo: 'reply_to',
  html: 'html',              // long-text property holding raw HTML
  htmlFileId: 'html_file_id', // file id OR full URL to the HTML file
};

// Input fields that control the send rather than acting as merge tokens.
const RESERVED_INPUTS = new Set(['transactional_email_id', 'email', 'hs_object_id']);

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested — see test/render.test.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace {{ token }} occurrences with values from `tokens`.
 * Unknown tokens render as an empty string. Whitespace inside the braces is
 * tolerated: {{firstname}} and {{ firstname }} are equivalent.
 */
function mergeTags(input, tokens) {
  if (input == null) return '';
  return String(input).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = tokens[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Deterministically remove the footer. The HTML author wraps the footer in a
 * marker the code strips wholesale:
 *   <!--FOOTER_START--> … <!--FOOTER_END-->   (recommended — survives nesting)
 * A single, non-nested <div data-footer>…</div> is also removed as a fallback.
 */
function stripFooter(html) {
  if (html == null) return '';
  return String(html)
    .replace(/<!--\s*FOOTER_START\s*-->[\s\S]*?<!--\s*FOOTER_END\s*-->/gi, '')
    .replace(/<div[^>]*\bdata-footer\b[^>]*>[\s\S]*?<\/div>/gi, '');
}

/** Build the contact merge-token map from the workflow input fields. */
function tokensFromInputs(inputFields) {
  const tokens = {};
  for (const [key, value] of Object.entries(inputFields || {})) {
    if (RESERVED_INPUTS.has(key)) continue;
    tokens[key] = value;
  }
  // Make the recipient address available as {{email}} too.
  if (inputFields && inputFields.email != null) tokens.email = inputFields.email;
  return tokens;
}

/**
 * Assemble the SES v2 SendEmail request body. `subject` and `html` are merged
 * against `tokens`; the footer is stripped from the HTML first.
 */
function buildEmailPayload({ subject, html, fromName, fromEmail, replyTo, toEmail, tokens, configurationSet }) {
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const body = {
    FromEmailAddress: from,
    Destination: { ToAddresses: [toEmail] },
    Content: {
      Simple: {
        Subject: { Data: mergeTags(subject, tokens), Charset: 'UTF-8' },
        Body: { Html: { Data: mergeTags(stripFooter(html), tokens), Charset: 'UTF-8' } },
      },
    },
  };
  if (replyTo) body.ReplyToAddresses = [replyTo];
  if (configurationSet) body.ConfigurationSetName = configurationSet;
  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot API
// ─────────────────────────────────────────────────────────────────────────────

async function hubspotGet(path, token) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`HubSpot GET ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Fetch the Transactional Email record's properties. */
async function fetchTransactionalEmail(objectType, id, token) {
  const properties = Object.values(PROPS).join(',');
  const record = await hubspotGet(
    `/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(id)}?properties=${properties}`,
    token,
  );
  return record.properties || {};
}

/**
 * Resolve the email HTML from the record. Prefers the long-text property; falls
 * back to a file id (via the Files API) or a direct URL.
 */
async function resolveHtml(props, token) {
  const inline = props[PROPS.html];
  if (inline && inline.trim()) return inline;

  const ref = props[PROPS.htmlFileId];
  if (!ref || !String(ref).trim()) {
    throw new Error(
      `No HTML on the record: set the "${PROPS.html}" property or "${PROPS.htmlFileId}" (file id or URL)`,
    );
  }
  const url = /^https?:\/\//i.test(ref) ? ref : (await hubspotGet(`/files/v3/files/${ref}`, token)).url;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch HTML file → ${res.status} ${res.statusText}`);
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// AWS SES v2 send (manual SigV4 — no aws-sdk dependency)
// ─────────────────────────────────────────────────────────────────────────────

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

async function sesSendEmail(payload, { accessKeyId, secretAccessKey, sessionToken, region }) {
  const service = 'ses';
  const host = `email.${region}.amazonaws.com`;
  const path = '/v2/email/outbound-emails';
  const body = JSON.stringify(payload);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    'content-type': 'application/json',
    host,
    'x-amz-date': amzDate,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((h) => `${h}:${headers[h]}\n`)
    .join('');

  const canonicalRequest = [
    'POST',
    path,
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    sha256hex(body),
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: { ...headers, Authorization: authorization },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SES send → ${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot custom code entry point
// ─────────────────────────────────────────────────────────────────────────────

exports.main = async (event, callback) => {
  const done = (fields) => (typeof callback === 'function' ? callback({ outputFields: fields }) : fields);
  try {
    const env = process.env;
    const inputs = event.inputFields || {};

    const objectType = env.TRANSACTIONAL_EMAIL_OBJECT_TYPE;
    const token = env.HUBSPOT_TOKEN;
    const emailId = inputs.transactional_email_id;
    const toEmail = inputs.email;

    if (!objectType) throw new Error('Missing secret TRANSACTIONAL_EMAIL_OBJECT_TYPE');
    if (!token) throw new Error('Missing secret HUBSPOT_TOKEN');
    if (!emailId) throw new Error('Missing input field transactional_email_id');
    if (!toEmail) throw new Error('Missing input field email (recipient)');

    const props = await fetchTransactionalEmail(objectType, emailId, token);
    const html = await resolveHtml(props, token);

    const payload = buildEmailPayload({
      subject: props[PROPS.subject] || '(no subject)',
      html,
      fromName: props[PROPS.fromName],
      fromEmail: props[PROPS.fromEmail],
      replyTo: props[PROPS.replyTo],
      toEmail,
      tokens: tokensFromInputs(inputs),
      configurationSet: env.SES_CONFIGURATION_SET,
    });

    if (!payload.FromEmailAddress || payload.FromEmailAddress === 'undefined') {
      throw new Error(`Record is missing "${PROPS.fromEmail}"`);
    }

    const result = await sesSendEmail(payload, {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
      region: env.AWS_REGION,
    });

    return done({ status: 'sent', messageId: result.MessageId || '', error: '' });
  } catch (err) {
    return done({ status: 'error', messageId: '', error: String(err && err.message ? err.message : err) });
  }
};

// Exported for unit tests + the local smoke test; harmless in the HubSpot
// runtime (only `main` is ever called there).
module.exports.mergeTags = mergeTags;
module.exports.stripFooter = stripFooter;
module.exports.tokensFromInputs = tokensFromInputs;
module.exports.buildEmailPayload = buildEmailPayload;
module.exports.sesSendEmail = sesSendEmail;
