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

## Storing the HTML on the record

Two supported options (you can use either; the sender prefers the property):

1. **`html` long-text property** — paste the raw HTML directly. Simplest.
   Watch HubSpot's property size limit for very large emails.
2. **`html_file_id` property** — a HubSpot **Files** file id (or a full URL) to
   an `.html` file. The sender fetches it via the Files API. Use this for large
   emails or when a designer maintains the file separately.

If both are set, the inline `html` property wins.
