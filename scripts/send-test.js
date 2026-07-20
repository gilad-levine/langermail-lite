'use strict';

/*
 * Local SES smoke test — verifies the SigV4 signing + SES v2 send path works
 * with your real AWS credentials, WITHOUT any HubSpot involvement. Run this
 * first to prove the AWS half before wiring up the workflow.
 *
 * It calls the exact same `buildEmailPayload` and `sesSendEmail` the HubSpot
 * action uses, so a success here means the SES half of production works.
 *
 * Usage:
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 \
 *   FROM_EMAIL=noreply@mail.langerlabs.com TO_EMAIL=you@example.com \
 *   npm run send-test
 *
 * Optional: FROM_NAME, REPLY_TO, SES_CONFIGURATION_SET, SUBJECT, AWS_SESSION_TOKEN
 */

const { buildEmailPayload, sesSendEmail } = require('../hubspot/custom-code-action.js');

async function main() {
  const env = process.env;
  const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'FROM_EMAIL', 'TO_EMAIL'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  const html = [
    '<html><body>',
    '<h1>LangerMail Lite — SES smoke test</h1>',
    '<p>Hi {{firstname}}, this proves SigV4 signing and SES delivery work.</p>',
    '<!--FOOTER_START--><p style="color:#999">This footer should NOT appear.</p><!--FOOTER_END-->',
    '</body></html>',
  ].join('');

  const payload = buildEmailPayload({
    subject: env.SUBJECT || 'LangerMail Lite smoke test ({{firstname}})',
    html,
    fromName: env.FROM_NAME,
    fromEmail: env.FROM_EMAIL,
    replyTo: env.REPLY_TO,
    toEmail: env.TO_EMAIL,
    tokens: { firstname: 'there' },
    configurationSet: env.SES_CONFIGURATION_SET,
  });

  const result = await sesSendEmail(payload, {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION,
  });

  console.log('Sent. SES MessageId:', result.MessageId || result.raw || '(none returned)');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
