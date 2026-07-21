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
- Whitespace inside the braces is fine: `{{ firstname }}` == `{{firstname}}`.
- **Unknown tokens render as an empty string** — they never leak `{{...}}` into
  the sent email. So a missing `firstname` just yields `Hi , thanks...`; guard
  against that with wording like `Hi {{firstname}}` → prefer `Hello there`
  fallbacks in copy, or always map the field.
- `{{email}}` is always available (the recipient address).
- Use **literal** `{{...}}` tags — **not** HubSpot personalization tokens. This
  sender does its own substitution.

## Footer removal — deterministic markers

Wrap the footer in a comment marker. Everything between the markers (inclusive)
is removed before sending:

```html
<!--FOOTER_START-->
<table> ... unsubscribe, address, legal ... </table>
<!--FOOTER_END-->
```

- Markers are **case-insensitive** and tolerate surrounding whitespace.
- The comment-marker form is the **recommended** one: it survives arbitrarily
  nested tables/divs inside the footer.
- A single, **non-nested** `<div data-footer>...</div>` is also stripped as a
  convenience, but do **not** use it if the footer contains nested `<div>`s —
  the marker form is safer. When in doubt, use `<!--FOOTER_START-->`.

If there is no footer to remove, simply omit the markers — HTML without them is
sent unchanged.

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
