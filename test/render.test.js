'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeTags,
  stripFooter,
  buildEmailPayload,
  looksEscaped,
  decodeHtmlEntities,
  unwrapViewSource,
  findTokens,
  normalizeKey,
  lookupToken,
} = require('../hubspot/custom-code-action.js');

// Mirrors the two-step config model in the action: define variables from the
// workflow inputs, then map {{tokens}} to those variables. Kept here so a
// regression in that flow is caught by tests.
function defineVariablesExample(event) {
  return {
    firstname: event.inputFields['firstname'],
    custom_variable: event.inputFields['custom_variable'],
  };
}
const EXAMPLE_TOKEN_MAP = { firstname: 'firstname', 'custom.variable': 'custom_variable' };

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

test('mergeTags resolves a dotted custom token from an underscore input', () => {
  // {{custom.variable}} in HTML → workflow input named custom_variable
  assert.equal(mergeTags('<p>{{custom.variable}}</p>', { custom_variable: 'Hello' }), '<p>Hello</p>');
});

test('mergeTags normalized matching is case-insensitive', () => {
  assert.equal(mergeTags('{{ Custom.Variable }}', { custom_variable: 'X' }), 'X');
});

test('mergeTags prefers an exact key over a normalized one', () => {
  assert.equal(mergeTags('{{firstname}}', { firstname: 'exact', Firstname: 'norm' }), 'exact');
});

test('normalizeKey lowercases and collapses non-alphanumerics to underscore', () => {
  assert.equal(normalizeKey('  Custom.Variable '), 'custom_variable');
  assert.equal(normalizeKey('contact.first-name'), 'contact_first_name');
});

test('lookupToken returns undefined for a genuinely missing token', () => {
  assert.equal(lookupToken({ firstname: 'A' }, 'company'), undefined);
});

test('lookupToken honors an explicit tokenMap (token name -> input name)', () => {
  const tokens = { firstname: 'Ada' };
  assert.equal(lookupToken(tokens, 'custom.first', { 'custom.first': 'firstname' }), 'Ada');
});

test('mergeTags applies tokenMap overrides ahead of normalized matching', () => {
  const html = '<p>{{custom.first}}</p>';
  assert.equal(mergeTags(html, { firstname: 'Ada' }, { 'custom.first': 'firstname' }), '<p>Ada</p>');
});

test('mergeTags without a tokenMap still auto-normalizes', () => {
  assert.equal(mergeTags('{{custom.variable}}', { custom_variable: 'V' }), 'V');
});

test('findTokens returns unique token names in first-seen order', () => {
  assert.deepEqual(
    findTokens('Hi {{firstname}}, your code {{custom.variable}} and {{firstname}} again'),
    ['firstname', 'custom.variable'],
  );
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

test('stripFooter auto-removes HubSpot last section (nested divs) with no markers', () => {
  const html =
    '<div class="hse-section"><div>Body content</div></div>' +
    '<div id="section-3" class="hse-section hse-section-last">' +
    '<div class="hse-column-container"><div class="hse-column">' +
    '<table class="hse-footer hse-secondary"><tbody><tr><td>' +
    '<p>123 Anywhere St</p><p><a data-unsubscribe="true">Unsubscribe</a></p>' +
    '</td></tr></tbody></table></div></div></div>';
  const out = stripFooter(html);
  assert.equal(out, '<div class="hse-section"><div>Body content</div></div>');
  assert.ok(!/Unsubscribe/.test(out));
  assert.ok(!/hse-footer/.test(out));
});

test('stripFooter falls back to the hse-footer table when no section wrapper', () => {
  const html =
    '<div>Keep me</div>' +
    '<table class="hse-footer"><tbody><tr><td>footer bits</td></tr></tbody></table>' +
    '<div>Keep me too</div>';
  assert.equal(stripFooter(html), '<div>Keep me</div><div>Keep me too</div>');
});

test('stripFooter does not touch content when no hse-footer / marker present', () => {
  const html =
    '<div class="hse-section hse-section-last"><p>Real last-section content, not a footer</p></div>';
  assert.equal(stripFooter(html), html);
});

test('stripFooter still honors manual FOOTER markers alongside HubSpot detection', () => {
  const html = '<p>Body</p><!--FOOTER_START--><p>manual footer</p><!--FOOTER_END-->';
  assert.equal(stripFooter(html), '<p>Body</p>');
});

test('looksEscaped detects entity-escaped markup', () => {
  assert.equal(looksEscaped('&lt;!DOCTYPE html&gt;&lt;div&gt;hi&lt;/div&gt;'), true);
});

test('looksEscaped is false for real HTML', () => {
  assert.equal(looksEscaped('<!DOCTYPE html><div>hi &amp; bye</div>'), false);
});

test('looksEscaped is false for plain text without entities', () => {
  assert.equal(looksEscaped('just some words'), false);
});

test('decodeHtmlEntities un-escapes markup, &amp; last', () => {
  assert.equal(
    decodeHtmlEntities('&lt;a href=&quot;?x=1&amp;y=2&quot;&gt;A&#39;s&lt;/a&gt;'),
    '<a href="?x=1&y=2">A\'s</a>',
  );
});

test('unwrapViewSource leaves normal HTML untouched', () => {
  const html = '<div>hello</div>';
  assert.equal(unwrapViewSource(html), html);
});

test('unwrapViewSource reconstructs source from a saved view-source page', () => {
  const page =
    '<div class="line-gutter-backdrop"></div>' +
    '<form><label class="line-wrap-control">Line wrap<input type="checkbox"></label></form>' +
    '<table><tbody>' +
    '<tr><td class="line-number" value="1"></td><td class="line-content">' +
    '<span class="html-tag">&lt;div&gt;</span>Hi <a href="https://x/?a=1&amp;b=2">' +
    'https://x/?a=1&amp;amp;b=2</a><span class="html-tag">&lt;/div&gt;</span></td></tr>' +
    '<tr><td class="line-number" value="2"></td><td class="line-content">' +
    '<span class="html-comment">&lt;!--FOOTER_START--&gt;</span>x' +
    '<span class="html-comment">&lt;!--FOOTER_END--&gt;</span></td></tr>' +
    '</tbody></table>';
  const recovered = unwrapViewSource(page);
  assert.match(recovered, /<div>Hi https:\/\/x\/\?a=1&amp;b=2<\/div>/);
  assert.match(recovered, /<!--FOOTER_START-->x<!--FOOTER_END-->/);
  // and the recovered source is now processable end to end
  assert.equal(stripFooter(recovered).includes('FOOTER'), false);
});

test('define-variables + token-map flow renders both token styles', () => {
  const event = { inputFields: { email: 'a@b.com', firstname: 'Ada', custom_variable: 'PROMO-42' } };
  const vars = { email: event.inputFields.email, ...defineVariablesExample(event) };
  const html = 'Hi {{firstname}} ({{email}}) code {{custom.variable}}';
  assert.equal(mergeTags(html, vars, EXAMPLE_TOKEN_MAP), 'Hi Ada (a@b.com) code PROMO-42');
});

test('token-map entry is optional when token name equals variable name', () => {
  const event = { inputFields: { firstname: 'Ada' } };
  const vars = defineVariablesExample(event);
  // no map entry for firstname → still resolves by matching name
  assert.equal(mergeTags('{{firstname}}', vars, {}), 'Ada');
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
