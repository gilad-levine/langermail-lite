'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeTags,
  stripFooter,
  tokensFromInputs,
  buildEmailPayload,
} = require('../hubspot/custom-code-action.js');

test('mergeTags substitutes known tokens', () => {
  assert.equal(mergeTags('Hi {{firstname}}!', { firstname: 'Ada' }), 'Hi Ada!');
});

test('mergeTags tolerates inner whitespace', () => {
  assert.equal(mergeTags('Hi {{  firstname  }}', { firstname: 'Ada' }), 'Hi Ada');
});

test('mergeTags renders unknown tokens as empty string', () => {
  assert.equal(mergeTags('Hi {{missing}}!', { firstname: 'Ada' }), 'Hi !');
});

test('mergeTags renders null/undefined values as empty string', () => {
  assert.equal(mergeTags('[{{a}}][{{b}}]', { a: null, b: undefined }), '[][]');
});

test('mergeTags coerces non-string values', () => {
  assert.equal(mergeTags('n={{count}}', { count: 3 }), 'n=3');
});

test('mergeTags supports dotted token names', () => {
  assert.equal(mergeTags('{{company.name}}', { 'company.name': 'Langer' }), 'Langer');
});

test('mergeTags handles null input', () => {
  assert.equal(mergeTags(null, {}), '');
});

test('stripFooter removes the comment-marked footer inclusively', () => {
  const html = '<p>Body</p><!--FOOTER_START--><table>junk</table><!--FOOTER_END--><p>after</p>';
  assert.equal(stripFooter(html), '<p>Body</p><p>after</p>');
});

test('stripFooter marker matching is case-insensitive and whitespace-tolerant', () => {
  const html = 'A<!--  footer_start  -->X<!--  footer_end  -->B';
  assert.equal(stripFooter(html), 'AB');
});

test('stripFooter removes a non-nested data-footer div fallback', () => {
  const html = '<div>keep</div><div data-footer>bye</div><div>keep2</div>';
  assert.equal(stripFooter(html), '<div>keep</div><div>keep2</div>');
});

test('stripFooter leaves HTML without a footer marker untouched', () => {
  const html = '<p>No footer here</p>';
  assert.equal(stripFooter(html), html);
});

test('tokensFromInputs drops reserved control fields', () => {
  const tokens = tokensFromInputs({
    transactional_email_id: '123',
    email: 'a@b.com',
    hs_object_id: '999',
    firstname: 'Ada',
    company: 'Langer',
  });
  assert.deepEqual(tokens, { firstname: 'Ada', company: 'Langer', email: 'a@b.com' });
});

test('buildEmailPayload merges subject + html and strips footer', () => {
  const payload = buildEmailPayload({
    subject: 'Hello {{firstname}}',
    html: '<p>Hi {{firstname}}</p><!--FOOTER_START-->x<!--FOOTER_END-->',
    fromName: 'Langer Labs',
    fromEmail: 'noreply@mail.langerlabs.com',
    toEmail: 'ada@example.com',
    tokens: { firstname: 'Ada' },
  });
  assert.equal(payload.FromEmailAddress, 'Langer Labs <noreply@mail.langerlabs.com>');
  assert.deepEqual(payload.Destination.ToAddresses, ['ada@example.com']);
  assert.equal(payload.Content.Simple.Subject.Data, 'Hello Ada');
  assert.equal(payload.Content.Simple.Body.Html.Data, '<p>Hi Ada</p>');
});

test('buildEmailPayload omits fromName wrapper when absent', () => {
  const payload = buildEmailPayload({
    subject: 's',
    html: 'h',
    fromEmail: 'noreply@mail.langerlabs.com',
    toEmail: 'ada@example.com',
    tokens: {},
  });
  assert.equal(payload.FromEmailAddress, 'noreply@mail.langerlabs.com');
});

test('buildEmailPayload includes optional replyTo and configuration set', () => {
  const payload = buildEmailPayload({
    subject: 's',
    html: 'h',
    fromEmail: 'noreply@mail.langerlabs.com',
    replyTo: 'support@langerlabs.com',
    toEmail: 'ada@example.com',
    tokens: {},
    configurationSet: 'default-set',
  });
  assert.deepEqual(payload.ReplyToAddresses, ['support@langerlabs.com']);
  assert.equal(payload.ConfigurationSetName, 'default-set');
});
