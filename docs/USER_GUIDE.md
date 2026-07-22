# LangerMail Lite — User Guide

How to send a transactional email from HubSpot with this tool. No servers, no
web app — one **custom code action** in a HubSpot workflow reads a
**Transactional Email** record, personalizes it, and sends it through **AWS
SES**.

This guide is for anyone with access to the code. It covers a first-time
instance setup, then the repeatable "new email" flow, then the part most people
come here for: **adding inputs and mapping them to `{{tokens}}`**.

---

## How it works (30-second version)

```
Contact enrolled in workflow
        │
        ▼
Custom Code Action ──► reads the Transactional Email record (RECORD_ID)
                       ├─ gets the HTML (uploaded file, or rich-text property)
                       ├─ strips the HubSpot footer automatically
                       ├─ fills {{tokens}} from the workflow input fields
                       └─ sends via AWS SES  ✉️
```

- **One workflow = one email.** The email it sends is fixed by `RECORD_ID` at
  the top of the code.
- **Personalization** happens through `{{tokens}}` in the email HTML, filled
  from **workflow input fields** you map to contact properties.

---

## Prerequisites (one-time, per HubSpot instance)

1. **Operations Hub Professional or Enterprise** — required for custom code
   actions.
2. **AWS SES** already set up with a verified sending domain
   (`mail.langerlabs.com`) and out of the sandbox.
3. **A HubSpot Private App** with these scopes:
   `crm.objects.custom.read`, `crm.objects.contacts.read`, `files`.
   Copy its access token.
4. **A "Transactional Email" custom object** with these properties (internal
   names in parentheses — if yours differ, update the `PROPS` block in the code):
   - Subject (`subject_line`) — single-line text
   - From name (`from_name`) and From address (`from_address`)
   - Reply-to (`replyto_address`)
   - HTML file (`body_html_file`) — file upload **(preferred)**
   - HTML text (`body_html_text`) — rich text (fallback)

---

## Set up a new email (repeat per email)

### 1. Create the Transactional Email record

Create a record of the custom object and fill in Subject / From name / From
address / Reply-to. Add the **HTML** — see [Authoring the HTML](#authoring-the-html-important).

Note the **record id** — it's the number in the record URL:
`…/objects/2-66209712/record/`**`59082949729`**.

### 2. Create the workflow + code action

1. New **contact-based workflow**; set your enrollment trigger.
2. Add action → **Custom code** → language **Node.js**.
3. Paste the entire contents of
   [`hubspot/custom-code-action.js`](../hubspot/custom-code-action.js).

### 3. Add secrets (first workflow only; secrets are shared)

In the code action's **Secrets** panel, add:

| Secret | Value |
|---|---|
| `legacyApp` | the Private App access token |
| `AWS_ACCESS_KEY_ID` | SES IAM key id (`AKIA…`, 20 chars) |
| `AWS_SECRET_ACCESS_KEY` | SES IAM secret (~40 chars, may contain `/`) |
| `AWS_REGION` | the region your domain is verified in, e.g. `us-east-1` |
| `SES_CONFIGURATION_SET` | *(optional)* only for open/click/bounce tracking |

### 4. Set `RECORD_ID`

At the very top of the code, in the **CONFIGURE ME** block:

```js
const RECORD_ID = '59082949729';   // ← your record id from step 1
```

### 5. Add inputs & map tokens

This is the personalization wiring — see the next section.

### 6. Test

Use **Test action** with a sample contact (or enroll one). Read the logs
(next-but-one section). When it says `SES OK. MessageId: …`, you're live. Flip
`DEBUG = false` when you're done setting up.

---

## Add inputs & map tokens

**Goal:** a `{{token}}` in your email HTML gets replaced, per recipient, with a
value from the contact. There are **four** pieces, and they line up like this:

```
  {{firstname}}                  ← 1. token in the email HTML
        │
  input field "firstname"        ← 2. added in the action, mapped to a contact property
        │
  firstname: event.inputFields['firstname']   ← 3. defineVariables (top of code)
        │
  TOKEN_MAP: { firstname: 'firstname' }        ← 4. token → variable (top of code)
```

### Step 1 — put the token in the email

In the email HTML, write the token as literal text, e.g. `{{firstname}}` or
`{{custom.variable}}`. (See [Authoring](#authoring-the-html-important) for why it
must be a *literal custom* token, not a HubSpot personalization token.)

### Step 2 — add the input field in the action

In the custom code action, find the **"Property to include in code"** panel
(next to the code editor). For each value:

1. Click **Add property**.
2. **Property to include:** the contact property that holds the value
   (e.g. *First name*).
3. **Input name:** the name the code reads (e.g. `firstname`). Use letters,
   numbers, and underscores.

Always add one input named **`email`** mapped to **Contact → Email** — that's the
recipient (required, and handled for you as `{{email}}`).

### Step 3 — define the variable (top of code)

In the **CONFIGURE ME** block, add one line per value inside `defineVariables`,
reading the input field you just created:

```js
function defineVariables(event) {
  return {
    firstname:       event.inputFields['firstname'],
    custom_variable: event.inputFields['custom_variable'],
    // company:      event.inputFields['company'],
  };
}
```

### Step 4 — map the token to the variable (top of code)

In `TOKEN_MAP`, connect each email token (left) to a variable from step 3
(right):

```js
const TOKEN_MAP = {
  firstname:         'firstname',        // {{firstname}}        → firstname
  'custom.variable': 'custom_variable',  // {{custom.variable}}  → custom_variable
};
```

> **Shortcut:** if the token is spelled exactly like the variable
> (`{{firstname}}` ↔ `firstname`), the `TOKEN_MAP` line is optional — it resolves
> by name. Add a line whenever the token and variable names differ, e.g.
> `'custom.variable': 'promo'`.

### How do I know which tokens an email needs?

Run the action and read the log. It prints:

```
Tokens in template: firstname, custom.variable
All template tokens matched an input.
```

or, if something isn't wired up:

```
Unmatched tokens (sent empty): custom.variable
```

An unmatched token is sent as an **empty string** (never a literal `{{…}}`), so
fix the mapping if you see one listed.

---

## Authoring the HTML (important)

Full detail in [`HTML_AUTHORING.md`](HTML_AUTHORING.md). The three things that
bite people:

1. **Use literal custom tokens, not HubSpot's built-in personalization tokens.**
   HubSpot *resolves its own tokens to a static value when it exports the email*
   — e.g. `{{ contact.firstname }}` becomes the literal word "there". Only tokens
   HubSpot doesn't recognize (like `{{custom.variable}}`) survive to be
   personalized here. So type `{{firstname}}` as plain text.

2. **Get clean source HTML.** The tool auto-recovers from common mistakes (a
   browser *view-source* save, or entity-escaped HTML), but the cleanest source
   is HubSpot's **Export/Copy HTML**, or *Ctrl+U → Select All → Copy → paste into
   a plain-text editor → save as `.html`*. Don't "Save As → Webpage, Complete"
   (that breaks image paths).

3. **Footer is removed automatically** for HubSpot emails (it detects HubSpot's
   `hse-footer` markup). To force-remove a footer in non-HubSpot HTML, wrap it in
   `<!--FOOTER_START-->…<!--FOOTER_END-->`.

Store the HTML in **`body_html_file`** (upload the file) — it's preferred over
the rich-text property, which escapes raw HTML.

---

## Reading the logs / debugging

With `DEBUG = true`, each run logs its progress. A healthy run:

```
Reading 2-66209712/59082949729 ...
HTML source: file "body_html_file" (217682575426)
Detected a saved view-source page; reconstructed the real HTML   (only if needed)
Tokens in template: firstname, custom.variable
All template tokens matched an input.
Sending "Welcome" from Name <test@mail.langerlabs.com> to jane@acme.com ...
SES OK. MessageId: 0100... (612ms)
```

On failure you get the **stage** it broke at, plus the message and stack:

```
FAILED at stage "ses-send" after 240ms: SES send -> 403 { ... }
```

and the action's `error` output field is `[stage] message`, which you can branch
on in the workflow.

### Troubleshooting

| Symptom / log | Cause | Fix |
|---|---|---|
| `Missing configuration: secret …` | A secret isn't set | Add it in the Secrets panel |
| `Missing input field "email"` | No `email` input | Add input `email` → Contact Email |
| `SES send -> 403 Credential must have exactly 5 …` | Access key id / secret swapped | Key id is `AKIA…` (20 chars); secret is ~40 chars |
| `SES send -> 400 … not verified` | Wrong region or from-address | Set `AWS_REGION` to the verified region; use an address on the verified domain |
| Email shows raw HTML as text | Escaped/view-source HTML | Handled automatically now; if it persists, re-upload clean source HTML |
| Images broken | Relative image paths | Use source HTML with absolute `https://` image URLs (Export/Copy HTML) |
| A `{{token}}` came out blank | No matching input | Check `Unmatched tokens` log; add/rename the input or use `TOKEN_MAP` |
| Footer still present | Non-HubSpot HTML | Wrap it in `<!--FOOTER_START-->…<!--FOOTER_END-->` |

---

## Quick reference — what you edit where

| Thing | Where |
|---|---|
| Which email this workflow sends | `RECORD_ID` (top of code) |
| Define personalization values from inputs | `defineVariables` (top of code) |
| Map `{{tokens}}` → variables | `TOKEN_MAP` (top of code) |
| Verbose logging on/off | `DEBUG` (top of code) |
| Object property names | `PROPS` (top of code) |
| HubSpot token, AWS keys, region | **Secrets** panel (not the code) |
| Recipient + personalization values | **Input fields** panel (mapped to contact props) |
