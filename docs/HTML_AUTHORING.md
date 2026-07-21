# Writing HTML for a Transactional Email

The HTML you put on a **Transactional Email** record is sent almost verbatim.
Two conventions let the sender personalize it and drop the footer.

## Merge tags — `{{token}}`

Use double-brace tokens anywhere in the **subject** or the **HTML body**:

```html
<p>Hi {{firstname}}, thanks for joining {{company}}.</p>
```

- A token is replaced with the value of the matching **workflow input field**
  (which you map to a contact property — see the main README).
- **Input-field names can't contain dots**, so a dotted token matches the
  underscore form: `{{custom.variable}}` → input `custom_variable`,
  `{{firstname}}` → input `firstname`. Matching is case-insensitive.
- Whitespace inside the braces is fine: `{{ firstname }}` == `{{firstname}}`.
- **Unknown tokens render as an empty string** — they never leak `{{...}}` into
  the sent email. So a missing `firstname` just yields `Hi , thanks...`; always
  map the field, or word copy to tolerate a blank.
- `{{email}}` is always available (the recipient address).
- The run log prints `Tokens in template: …` and `Unmatched tokens (sent
  empty): …` so you can see exactly which input fields an email needs.

### ⚠️ Do NOT use HubSpot's built-in personalization tokens

Use **literal, custom** `{{...}}` tokens typed as plain text — **not** HubSpot's
personalization widget (the "First name" / contact-property dropdown).

**Why:** HubSpot *resolves its own recognized tokens when it renders/exports the
email*. A built-in `{{ contact.firstname }}` gets baked to a static value at
export time — e.g. the default **"there"** — so it never reaches this sender as
a token and can't be personalized per recipient. Tokens HubSpot doesn't
recognize (like `{{custom.variable}}`) pass through untouched.

So for **every** value you want personalized — including first name — insert a
custom token like `{{firstname}}` as literal text (the same way a custom token
such as `{{custom.variable}}` is added), then map an input field to the contact
property. That way the value is filled at send time, per recipient.

## Footer removal — automatic for HubSpot emails

**If you author in HubSpot, you don't need to do anything.** HubSpot tags its
footer with stable classes (`hse-footer`, and the enclosing
`hse-section-last`), and the sender detects and removes that block
automatically — including all its nested tables/divs. No per-email markup.

This removes the last-section footer (unsubscribe + physical address). If you
*want* to keep a footer, either don't let HubSpot generate one, or move the
content out of the last section.

### Manual override (non-HubSpot HTML)

If your HTML isn't HubSpot-authored, wrap the footer in comment markers and
everything between them (inclusive) is removed:

```html
<!--FOOTER_START-->
  ... unsubscribe, address, legal ...
<!--FOOTER_END-->
```

Markers are case-insensitive and whitespace-tolerant. A single, **non-nested**
`<div data-footer>...</div>` is also stripped as a convenience. HTML with no
recognizable footer is sent unchanged.

## Images must use absolute URLs

Email clients can't resolve relative paths. Every `<img src>` (and any CSS
`url(...)`) must be an absolute `https://…` link.

> **Do not upload a browser "Save page as" export.** It rewrites assets to
> relative paths like `./email_files/logo.png` (broken in email) and injects
> browser-extension markup. Instead use HubSpot's **Export / Copy HTML** from
> the email editor, which keeps absolute CDN image URLs.

## Storing the HTML on the record

Two supported options — the sender tries the **file first**, then the property:

1. **`body_html_file` (file upload) — preferred.** Upload the `.html` file. It
   holds true, unescaped HTML. The sender fetches it via the Files API
   *signed-url* endpoint (works for private CRM attachments). Best for full
   templates.
2. **`body_html_text` (rich text) — fallback.** Fine for simple formatted
   snippets. **Do not paste a full HTML template's source here** — the rich-text
   editor escapes the markup (`&lt;div&gt;…`), so the recipient sees the tags as
   text. Watch HubSpot's property size limit too.

If the file is present it wins; otherwise the rich-text property is used.
