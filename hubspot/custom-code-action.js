'use strict';

/*
 * LangerMail Lite — HubSpot Custom Code Action (Design A)
 * -------------------------------------------------------
 * Paste this whole file into an Operations Hub "Custom code" workflow action.
 * It reads a "Transactional Email" custom object, resolves its HTML (from the
 * attached file, falling back to the rich-text property), strips a
 * marker-delimited footer, substitutes {{merge_tags}} from the enrolled
 * contact, and sends via AWS SES — with zero external dependencies (Node
 * built-in `https` + `crypto`, so it runs on any HubSpot code-step runtime and
 * can't break on the package allowlist).
 *
 * ── Secrets to configure on the code action ────────────────────────────────
 *   legacyApp                        HubSpot private-app access token (scopes below)
 *   AWS_ACCESS_KEY_ID                SES sender IAM key id
 *   AWS_SECRET_ACCESS_KEY            SES sender IAM secret
 *   AWS_REGION                       SES region, e.g. us-east-1  (must match
 *                                    where mail.langerlabs.com is verified)
 *   TRANSACTIONAL_EMAIL_OBJECT_TYPE  (optional) custom object type id/FQN;
 *                                    defaults to DEFAULT_OBJECT_TYPE below
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

const https = require('https');
const crypto = require('crypto');

// Default custom object type (Transactional Email). Override with the
// TRANSACTIONAL_EMAIL_OBJECT_TYPE secret if it ever changes.
const DEFAULT_OBJECT_TYPE = '2-66209712';

// ── Property names on the Transactional Email object (override here if yours differ) ──
const PROPS = {
  subject: 'subject_line',
  fromName: 'from_name',
  fromEmail: 'from_address',
  replyTo: 'replyto_address',
  html: 'body_html_text', // rich-text property (fallback; escapes raw HTML source)
  htmlFile: 'body_html_file', // file-upload property (preferred; true raw HTML)
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
 * HTML without either marker is returned unchanged.
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
// HTTPS helper (Node built-in; follows one redirect; no external deps)
// ─────────────────────────────────────────────────────────────────────────────

function httpsRequest(urlString, { method = 'GET', headers = {}, body } = {}, redirectsLeft = 1) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + u.search, headers },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, urlString).toString();
          return resolve(httpsRequest(next, { method, headers, body }, redirectsLeft - 1));
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HubSpot API
// ─────────────────────────────────────────────────────────────────────────────

async function hubspotGet(path, token) {
  const res = await httpsRequest(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HubSpot GET ${path} -> ${res.status} ${res.body}`);
  }
  return JSON.parse(res.body);
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
 * Resolve the email HTML from the record. Prefers the uploaded file (true raw
 * HTML) and falls back to the rich-text property. Private CRM-attached files
 * need a *signed* download URL — the plain metadata `url` points at an
 * authenticated HubSpot page (a JS shell), not the file bytes.
 */
async function resolveHtml(props, token) {
  const ref = props[PROPS.htmlFile];
  if (ref && String(ref).trim()) {
    const url = /^https?:\/\//i.test(ref)
      ? ref
      : (await hubspotGet(`/files/v3/files/${ref}/signed-url`, token)).url;
    const res = await httpsRequest(url);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Fetch HTML file ${ref} -> ${res.status} ${res.body.slice(0, 200)}`);
    }
    return res.body;
  }

  const inline = props[PROPS.html];
  if (inline && inline.trim()) return inline;

  throw new Error(`No HTML: "${PROPS.htmlFile}" and "${PROPS.html}" are both empty`);
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

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
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

  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await httpsRequest(`https://${host}${path}`, {
    method: 'POST',
    headers: { ...headers, Authorization: authorization },
    body,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`SES send -> ${res.status} ${res.body}`);
  try {
    return JSON.parse(res.body);
  } catch {
    return { raw: res.body };
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

    const objectType = env.TRANSACTIONAL_EMAIL_OBJECT_TYPE || DEFAULT_OBJECT_TYPE;
    const token = env.legacyApp || env.HUBSPOT_TOKEN;
    const emailId = inputs.transactional_email_id;
    const toEmail = inputs.email;

    if (!token) throw new Error('Missing HubSpot token (secret "legacyApp")');
    if (!emailId) throw new Error('Missing input field transactional_email_id');
    if (!toEmail) throw new Error('Missing input field email (recipient)');

    console.log(`Reading ${objectType}/${emailId} ...`);
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

    if (!payload.FromEmailAddress || /(^|<)undefined(>|$)/.test(payload.FromEmailAddress)) {
      throw new Error(`Record is missing "${PROPS.fromEmail}"`);
    }

    console.log(`Sending "${payload.Content.Simple.Subject.Data}" to ${toEmail} ...`);
    const result = await sesSendEmail(payload, {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
      region: env.AWS_REGION,
    });
    console.log('SES OK. MessageId:', result.MessageId || '(none)');

    return done({ status: 'sent', messageId: result.MessageId || '', error: '' });
  } catch (err) {
    console.error('FAILED:', err && err.message ? err.message : err);
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
